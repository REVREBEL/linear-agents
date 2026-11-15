/**
 * REVREBEL Linear Agent Bridge — EventIntelligence Module
 * Semantic GitHub/Linear Webhook Triage and Automated Review Dispatch (ABR-18)
 *
 * Implements:
 * 1. Normalized Event & Enriched Context Schemas
 * 2. Deterministic Pre-Filter (ABR-7 Self-Origin Gate & Bot Suppression)
 * 3. Context Enrichment Service Interface (GitHub API / Linear GraphQL / Checkpoints)
 * 4. Gemma Decision Engine (OpenRouter hosted inference with JSON schema validation)
 * 5. Deterministic Policy Gate & Semantic Work Deduplication Key Engine
 * 6. EventIntelligenceAgent Orchestrator
 */

import { createHash } from 'node:crypto';
import { ParallelDecisionsAdapter, type WebhookTriageEvaluation } from './decisions-adapter.ts';

/**
 * EventIntelligence Type Definitions
 * Schema definitions for event normalization, context enrichment,
 * semantic classification, and deterministic policy enforcement.
 */

export type EventProvider = 'github' | 'linear';

export type NormalizedEventType =
  | 'pull_request.opened'
  | 'pull_request.ready_for_review'
  | 'pull_request.synchronize'
  | 'pull_request.closed'
  | 'pull_request_review.submitted'
  | 'pull_request_review_comment.created'
  | 'issue_comment.created'
  | 'check_run.completed'
  | 'Linear.AgentSessionEvent'
  | 'Linear.AppUserNotification'
  | 'Linear.Issue';

export interface EventActor {
  id: string | number;
  login: string;
  isBot: boolean;
  type?: 'User' | 'Bot' | 'App';
}

export interface EventTarget {
  repository?: string;
  prNumber?: number;
  issueId?: string;
  issueIdentifier?: string; // e.g. "ABR-18"
  baseSha?: string;
  headSha?: string;
}

export interface NormalizedEvent {
  id: string; // Delivery ID or webhook ID
  provider: EventProvider;
  eventType: NormalizedEventType;
  action?: string;
  actor: EventActor;
  target: EventTarget;
  timestamp: string;
  hasPromptContext: boolean;
  promptContext?: string;
  rawPayloadHash: string;
  bodySnippet?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckRunSummary {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | null;
}

export interface ReviewCheckpoint {
  reviewedHeadSha: string;
  reviewCycle: number;
  unresolvedFindingFingerprints: string[];
  lastVerdict?: 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED';
  updatedAt: string;
}

export interface EnrichedContext {
  event: NormalizedEvent;
  pr?: {
    title: string;
    description: string;
    state: 'open' | 'closed';
    isDraft: boolean;
    mergeable: boolean;
    headSha: string;
    baseRef: string;
    changedFilesCount: number;
  };
  checks?: CheckRunSummary[];
  priorCheckpoint?: ReviewCheckpoint;
  diffSummary?: {
    files: string[];
    truncatedHunks: string[];
  };
  enrichmentErrors?: string[];
  parallelTriage?: WebhookTriageEvaluation;
}

export type TriageDecision = 'ignore' | 'defer' | 'dispatch' | 'needs_human_review';

export type TriageIntent =
  | 'initial_pr_review'
  | 'revision_review'
  | 'implementation_followup'
  | 'clarification'
  | 'ci_failure'
  | 'dependency_security'
  | 'informational';

export type TriagePriority = 'low' | 'normal' | 'high' | 'critical';

export interface EventIntelligenceDecision {
  decision: TriageDecision;
  intent: TriageIntent;
  priority: TriagePriority;
  confidence: number; // 0.0 - 1.0 (advisory)
  reason: string;
  evidenceRefs: string[];
  missingContext?: string[];
  riskFlags?: string[];
  targetAgent?: string; // Advisory
}

export interface PolicyGateResult {
  action: TriageDecision;
  semanticWorkKey: string;
  intent: TriageIntent;
  priority: TriagePriority;
  reason: string;
  targetAgent: string;
  isModelOverridden: boolean;
  originalModelDecision?: EventIntelligenceDecision;
  metadata: {
    repository?: string;
    prNumber?: number;
    headSha?: string;
    reviewCycle?: number;
    timestamp: string;
  };
}

export interface EventIntelligenceConfig {
  mode: 'off' | 'shadow' | 'enforced';
  selfIds: (string | number)[];
  selfLogins: string[];
  openRouterApiKey?: string;
  modelId: string;
  timeoutMs: number;
  maxRetries: number;
  enableParallelDecisions?: boolean;
  parallelDecisionsActionableThreshold?: number;
}


/**
 * Deterministic Pre-Filter Module
 * Evaluates high-confidence deterministic rules before invoking LLM inference.
 */


export interface PreFilterResult {
  passed: boolean;
  immediateDecision?: {
    action: TriageDecision;
    intent: TriageIntent;
    reason: string;
  };
}

export function deterministicPreFilter(
  event: NormalizedEvent,
  config: EventIntelligenceConfig
): PreFilterResult {
  const actorIdStr = String(event.actor.id);
  const actorLogin = event.actor.login.toLowerCase();

  // 1. Self-Origin Loop Suppression Gate (ABR-7)
  const isSelfId = config.selfIds.some(id => String(id) === actorIdStr);
  const isSelfLogin = config.selfLogins.some(login => login.toLowerCase() === actorLogin);

  if (isSelfId || isSelfLogin) {
    return {
      passed: false,
      immediateDecision: {
        action: 'ignore',
        intent: 'informational',
        reason: `Suppressed by self-origin gate (ABR-7): actor '${event.actor.login}' matches ChatGPT writing identity.`
      }
    };
  }

  // 2. Closed Pull Requests / Finished Lifecycles
  if (event.eventType === 'pull_request.closed') {
    return {
      passed: false,
      immediateDecision: {
        action: 'ignore',
        intent: 'informational',
        reason: 'Pull request is closed or merged; no further automated review dispatch required.'
      }
    };
  }

  // 3. Known Non-Actionable Bot Notifications
  const benignBotLogins = ['codecov', 'codecov[bot]', 'github-actions', 'github-actions[bot]'];
  if (benignBotLogins.includes(actorLogin)) {
    // Only pass if it's explicitly a critical failure check run
    if (event.eventType !== 'check_run.completed') {
      return {
        passed: false,
        immediateDecision: {
          action: 'ignore',
          intent: 'informational',
          reason: `Routine automated bot notification from '${event.actor.login}'.`
        }
      };
    }
  }

  // 4. Linear AppUserNotification without promptContext and without linked targets
  if (event.eventType === 'Linear.AppUserNotification') {
    if (!event.hasPromptContext && !event.target.issueId && !event.target.prNumber) {
      return {
        passed: false,
        immediateDecision: {
          action: 'ignore',
          intent: 'informational',
          reason: 'Linear AppUserNotification contains no promptContext and lacks resolvable issue/PR target metadata.'
        }
      };
    }
  }

  // Event passed deterministic filters; eligible for context enrichment and model evaluation
  return { passed: true };
}


/**
 * Context Enrichment Service
 * Hydrates normalized webhook events with authoritative PR, Git, and CI state.
 */


export interface ExternalContextConnector {
  getPullRequest?(repo: string, prNumber: number): Promise<{
    title: string;
    description: string;
    state: 'open' | 'closed';
    isDraft: boolean;
    mergeable: boolean;
    headSha: string;
    baseRef: string;
    changedFilesCount: number;
  }>;
  getCheckRuns?(repo: string, ref: string): Promise<CheckRunSummary[]>;
  getReviewCheckpoint?(repo: string, prNumber: number): Promise<ReviewCheckpoint | null>;
  getDiffSummary?(repo: string, prNumber: number): Promise<{ files: string[]; truncatedHunks: string[] }>;
}

export class EventContextEnricher {
  private connector: ExternalContextConnector;

  constructor(connector: ExternalContextConnector) {
    this.connector = connector;
  }

  async enrich(event: NormalizedEvent): Promise<EnrichedContext> {
    const enriched: EnrichedContext = {
      event,
      enrichmentErrors: []
    };

    const repo = event.target.repository;
    const prNumber = event.target.prNumber;

    if (!repo || !prNumber) {
      return enriched;
    }

    // 1. Fetch Pull Request Details
    if (this.connector.getPullRequest) {
      try {
        enriched.pr = await this.connector.getPullRequest(repo, prNumber);
        // Synchronize headSha to event target if missing
        if (!event.target.headSha && enriched.pr.headSha) {
          event.target.headSha = enriched.pr.headSha;
        }
      } catch (err) {
        enriched.enrichmentErrors?.push(`PR details lookup failed: ${(err as Error).message}`);
      }
    }

    // 2. Fetch Check Runs for head SHA
    const headSha = event.target.headSha || enriched.pr?.headSha;
    if (headSha && this.connector.getCheckRuns) {
      try {
        enriched.checks = await this.connector.getCheckRuns(repo, headSha);
      } catch (err) {
        enriched.enrichmentErrors?.push(`Check runs lookup failed: ${(err as Error).message}`);
      }
    }

    // 3. Fetch Prior Review Checkpoints (ABR-6)
    if (this.connector.getReviewCheckpoint) {
      try {
        const cp = await this.connector.getReviewCheckpoint(repo, prNumber);
        if (cp) {
          enriched.priorCheckpoint = cp;
        }
      } catch (err) {
        enriched.enrichmentErrors?.push(`Review checkpoint lookup failed: ${(err as Error).message}`);
      }
    }

    // 4. Fetch Diff Excerpts
    if (this.connector.getDiffSummary) {
      try {
        enriched.diffSummary = await this.connector.getDiffSummary(repo, prNumber);
      } catch (err) {
        enriched.enrichmentErrors?.push(`Diff summary lookup failed: ${(err as Error).message}`);
      }
    }

    return enriched;
  }
}



export interface InferenceClient {
  complete(systemPrompt: string, userPrompt: string, modelId: string): Promise<string>;
}

export class GemmaDecisionEngine {
  private client?: InferenceClient;
  private modelId: string;

  constructor(client?: InferenceClient, modelId: string = 'google/gemma-4-26b-a4b-it:free') {
    this.client = client;
    this.modelId = modelId;
  }

  async classify(context: EnrichedContext): Promise<EventIntelligenceDecision> {
    if (!this.client) {
      return this.heuristicFallback(context);
    }

    try {
      const userPrompt = this.formatContextForPrompt(context);
      const systemPrompt = `You are EventIntelligence, an automated webhook triage classifier for a software engineering control plane.
Return ONLY a valid JSON object matching:
{
  "decision": "ignore" | "defer" | "dispatch" | "needs_human_review",
  "intent": "initial_pr_review" | "revision_review" | "implementation_followup" | "clarification" | "ci_failure" | "dependency_security" | "informational",
  "priority": "low" | "normal" | "high" | "critical",
  "confidence": 0.0 to 1.0,
  "reason": "explanation",
  "evidenceRefs": ["evidence"],
  "riskFlags": ["optional_flags"],
  "missingContext": ["optional_missing"]
}`;

      const responseText = await this.client.complete(systemPrompt, userPrompt, this.modelId);
      const parsed = JSON.parse(responseText);
      return this.validateDecisionSchema(parsed);
    } catch (err) {
      const fallback = this.heuristicFallback(context);
      fallback.reason = `[Inference fallback: ${(err as Error).message}] ${fallback.reason}`;
      return fallback;
    }
  }

  private formatContextForPrompt(context: EnrichedContext): string {
    const { event, pr, checks, priorCheckpoint } = context;
    return `EVENT ENVELOPE:
- Event: ${event.eventType}
- Provider: ${event.provider}
- Actor: ${event.actor.login} (isBot: ${event.actor.isBot})
- Target Repo: ${event.target.repository || 'unknown'}
- PR: #${event.target.prNumber || 'N/A'} (head: ${event.target.headSha || 'N/A'})
- Snippet: ${event.bodySnippet || 'none'}

ENRICHED STATE:
- PR Title: ${pr?.title || 'N/A'}
- PR Description: ${pr?.description ? pr.description.slice(0, 500) : 'none'}
- Draft Status: ${pr?.isDraft ? 'DRAFT' : 'READY'}
- CI Checks: ${checks ? checks.map(c => `${c.name}: ${c.conclusion || c.status}`).join(', ') : 'none'}
- Prior Checkpoint: ${priorCheckpoint ? `Cycle ${priorCheckpoint.reviewCycle} @ ${priorCheckpoint.reviewedHeadSha}` : 'none'}
- Unresolved Findings: ${priorCheckpoint?.unresolvedFindingFingerprints.join(', ') || 'none'}
- Parallel Decisions Triage: ${context.parallelTriage ? `changeType=${context.parallelTriage.changeType}, riskScore=${context.parallelTriage.riskScore}/5, actionableProb=${context.parallelTriage.actionableProbability.toFixed(2)}` : 'none'}`;
  }

  private validateDecisionSchema(parsed: any): EventIntelligenceDecision {
    const validDecisions: TriageDecision[] = ['ignore', 'defer', 'dispatch', 'needs_human_review'];
    const validIntents: TriageIntent[] = [
      'initial_pr_review',
      'revision_review',
      'implementation_followup',
      'clarification',
      'ci_failure',
      'dependency_security',
      'informational'
    ];
    const validPriorities: TriagePriority[] = ['low', 'normal', 'high', 'critical'];

    const decision = validDecisions.includes(parsed.decision) ? parsed.decision : 'needs_human_review';
    const intent = validIntents.includes(parsed.intent) ? parsed.intent : 'informational';
    const priority = validPriorities.includes(parsed.priority) ? parsed.priority : 'normal';

    return {
      decision,
      intent,
      priority,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.8,
      reason: String(parsed.reason || 'Classified by model'),
      evidenceRefs: Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs.map(String) : [],
      riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags.map(String) : [],
      missingContext: Array.isArray(parsed.missingContext) ? parsed.missingContext.map(String) : []
    };
  }

  public heuristicFallback(context: EnrichedContext): EventIntelligenceDecision {
    const { event, pr, checks, priorCheckpoint } = context;
    const bodyLower = (event.bodySnippet || pr?.description || '').toLowerCase();
    const titleLower = (pr?.title || '').toLowerCase();

    // 0. Parallel Decisions Fast-Path Guidance
    if (context.parallelTriage) {
      if (context.parallelTriage.changeType === 'security_patch' || context.parallelTriage.riskScore >= 4) {
        return {
          decision: 'dispatch',
          intent: 'dependency_security',
          priority: context.parallelTriage.riskScore === 5 ? 'critical' : 'high',
          confidence: Math.max(0.9, context.parallelTriage.actionableProbability),
          reason: `Parallel Decisions flagged high-risk/security update: ${context.parallelTriage.changeType} (risk: ${context.parallelTriage.riskScore}/5).`,
          evidenceRefs: ['parallel_decisions_security', ...context.parallelTriage.citations]
        };
      }
      if (!context.parallelTriage.isActionable && context.parallelTriage.changeType === 'routine_bump') {
        return {
          decision: 'ignore',
          intent: 'informational',
          priority: 'low',
          confidence: 0.95,
          reason: `Parallel Decisions classified as routine dependency bump (${context.parallelTriage.changeType}).`,
          evidenceRefs: ['parallel_decisions_routine_bump']
        };
      }
    }

    // 1. Critical Dependency Security / Advisory PRs
    if (bodyLower.includes('security advisory') || bodyLower.includes('vulnerability') || titleLower.includes('security patch') || bodyLower.includes('cve-')) {
      return {
        decision: 'dispatch',
        intent: 'dependency_security',
        priority: 'high',
        confidence: 0.95,
        reason: 'Detected security advisory patch requiring priority automated review.',
        evidenceRefs: ['security_advisory_keyword']
      };
    }

    // 2. Routine Automated Dependency Updates
    if (event.actor.login.includes('renovate') || titleLower.startsWith('chore(deps)')) {
      return {
        decision: 'ignore',
        intent: 'informational',
        priority: 'low',
        confidence: 0.9,
        reason: 'Routine non-security dependency update; suppressed per policy.',
        evidenceRefs: ['actor=renovate', 'non-security']
      };
    }

    // 3. Jules / Sourcery Optimization Comments
    if (event.actor.login.toLowerCase().includes('jules') || event.actor.login.toLowerCase().includes('sourcery')) {
      const isSubstantive = bodyLower.includes('performance') || bodyLower.includes('refactor') || bodyLower.includes('memory leak') || bodyLower.includes('syntax defect');
      if (isSubstantive) {
        return {
          decision: 'dispatch',
          intent: 'implementation_followup',
          priority: 'normal',
          confidence: 0.85,
          reason: `Substantive optimization recommendation from ${event.actor.login}.`,
          evidenceRefs: ['substantive_code_improvement']
        };
      }
      return {
        decision: 'ignore',
        intent: 'informational',
        priority: 'low',
        confidence: 0.8,
        reason: `Standard stylistic/informational comment from ${event.actor.login}.`,
        evidenceRefs: ['routine_bot_advice']
      };
    }

    // 4. Revision Push (synchronize)
    if (event.eventType === 'pull_request.synchronize') {
      const currentHead = event.target.headSha || pr?.headSha;
      const isNewSha = !priorCheckpoint || priorCheckpoint.reviewedHeadSha !== currentHead;
      
      const hasPendingChecks = checks?.some(c => c.status === 'in_progress' || c.status === 'queued');
      if (hasPendingChecks) {
        return {
          decision: 'defer',
          intent: 'clarification',
          priority: 'low',
          confidence: 0.9,
          reason: 'Commit pushed but CI check runs are still in progress; deferring review until checks settle.',
          evidenceRefs: ['checks_in_progress']
        };
      }

      if (isNewSha) {
        return {
          decision: 'dispatch',
          intent: 'revision_review',
          priority: 'normal',
          confidence: 0.9,
          reason: `New commit SHA ${currentHead?.slice(0, 7)} pushed representing an unreviewed revision cycle.`,
          evidenceRefs: [`headSha=${currentHead}`]
        };
      } else {
        return {
          decision: 'ignore',
          intent: 'informational',
          priority: 'low',
          confidence: 0.95,
          reason: 'Head SHA already matches the latest reviewed checkpoint.',
          evidenceRefs: ['sha_already_reviewed']
        };
      }
    }

    // 5. Initial PR Opened or Ready for Review
    if (event.eventType === 'pull_request.opened' || event.eventType === 'pull_request.ready_for_review') {
      if (pr?.isDraft) {
        return {
          decision: 'defer',
          intent: 'clarification',
          priority: 'low',
          confidence: 0.95,
          reason: 'Pull request is in Draft state; automated review deferred until marked ready for review.',
          evidenceRefs: ['isDraft=true']
        };
      }
      return {
        decision: 'dispatch',
        intent: 'initial_pr_review',
        priority: 'normal',
        confidence: 0.95,
        reason: 'New pull request ready for initial review dispatch.',
        evidenceRefs: ['pr_opened_ready']
      };
    }

    // 6. Linear Issue Moved to In Review
    if (event.eventType === 'Linear.Issue' || event.eventType === 'Linear.AppUserNotification') {
      if (event.target.headSha || pr?.headSha) {
        return {
          decision: 'dispatch',
          intent: 'initial_pr_review',
          priority: 'normal',
          confidence: 0.85,
          reason: 'Linear issue moved to In Review with verified active PR head SHA.',
          evidenceRefs: ['linear_in_review_verified_head']
        };
      }
    }

    return {
      decision: 'needs_human_review',
      intent: 'clarification',
      priority: 'low',
      confidence: 0.5,
      reason: 'Event contains ambiguous context that does not match standard deterministic policies.',
      evidenceRefs: ['ambiguous_payload']
    };
  }
}



export class PolicyGate {
  private config: EventIntelligenceConfig;

  constructor(config: EventIntelligenceConfig) {
    this.config = config;
  }

  computeSemanticWorkKey(context: EnrichedContext, findingFingerprint?: string): string {
    const repo = context.event.target.repository || 'unknown_repo';
    const prNumber = context.event.target.prNumber || 0;
    const headSha = context.event.target.headSha || context.pr?.headSha || 'no_sha';
    const cycle = context.priorCheckpoint ? context.priorCheckpoint.reviewCycle + 1 : 1;
    const fingerprint = findingFingerprint || (context.priorCheckpoint?.unresolvedFindingFingerprints.sort().join(',') || 'none');

    const rawKey = `${repo}:${prNumber}:${headSha}:cycle_${cycle}:findings_${fingerprint}`;
    return createHash('sha256').update(rawKey).digest('hex');
  }

  evaluate(
    context: EnrichedContext,
    modelDecision: EventIntelligenceDecision,
    isAlreadyClaimed: boolean = false
  ): PolicyGateResult {
    const semanticWorkKey = this.computeSemanticWorkKey(context);
    let finalAction: TriageDecision = modelDecision.decision;
    let finalReason = modelDecision.reason;
    let isOverridden = false;

    // Invariant 1: Self-Origin Gate Hard Override (ABR-7)
    const actorIdStr = String(context.event.actor.id);
    const actorLogin = context.event.actor.login.toLowerCase();
    const isSelf = this.config.selfIds.some(id => String(id) === actorIdStr) ||
                   this.config.selfLogins.some(login => login.toLowerCase() === actorLogin);

    if (isSelf) {
      finalAction = 'ignore';
      finalReason = 'Hard override: Self-authored ChatGPT activity suppressed by policy gate (ABR-7).';
      isOverridden = true;
    }

    // Invariant 2: Deduplication Gate
    if (finalAction === 'dispatch' && isAlreadyClaimed) {
      finalAction = 'ignore';
      finalReason = `Duplicate work suppressed: SemanticWorkKey (${semanticWorkKey.slice(0, 12)}...) already claimed.`;
      isOverridden = true;
    }

    // Invariant 3: Draft PR Gate
    if (finalAction === 'dispatch' && context.pr?.isDraft) {
      finalAction = 'defer';
      finalReason = 'Policy override: Cannot dispatch automated review for PR in Draft state.';
      isOverridden = true;
    }

    // Invariant 4: Running Checks Gate
    const hasRunningChecks = context.checks?.some(c => c.status === 'in_progress' || c.status === 'queued');
    if (finalAction === 'dispatch' && hasRunningChecks && modelDecision.intent !== 'dependency_security') {
      finalAction = 'defer';
      finalReason = 'Policy override: CI checks currently in progress; deferring until build artifacts settle.';
      isOverridden = true;
    }

    // Invariant 5: Shadow Mode Enforcement
    if (this.config.mode === 'shadow' && finalAction === 'dispatch') {
      finalAction = 'defer';
      finalReason = `[SHADOW MODE ONLY] Evaluated as dispatch, but automated triggering withheld: ${finalReason}`;
      isOverridden = true;
    }

    const targetAgent = 'chatgpt-reviewer';

    return {
      action: finalAction,
      semanticWorkKey,
      intent: modelDecision.intent,
      priority: modelDecision.priority,
      reason: finalReason,
      targetAgent,
      isModelOverridden: isOverridden,
      originalModelDecision: modelDecision,
      metadata: {
        repository: context.event.target.repository,
        prNumber: context.event.target.prNumber,
        headSha: context.event.target.headSha || context.pr?.headSha,
        reviewCycle: context.priorCheckpoint ? context.priorCheckpoint.reviewCycle + 1 : 1,
        timestamp: new Date().toISOString()
      }
    };
  }
}



export class EventIntelligenceAgent {
  private config: EventIntelligenceConfig;
  private enricher: EventContextEnricher;
  private decisionEngine: GemmaDecisionEngine;
  private policyGate: PolicyGate;
  private claimedWorkKeys: Set<string>;
  private decisionsAdapter?: ParallelDecisionsAdapter;

  constructor(
    config: EventIntelligenceConfig,
    connector: ExternalContextConnector = {},
    inferenceClient?: InferenceClient,
    decisionsAdapter?: ParallelDecisionsAdapter
  ) {
    this.config = config;
    this.enricher = new EventContextEnricher(connector);
    this.decisionEngine = new GemmaDecisionEngine(inferenceClient, config.modelId);
    this.policyGate = new PolicyGate(config);
    this.claimedWorkKeys = new Set<string>();
    this.decisionsAdapter = decisionsAdapter || (config.enableParallelDecisions ? new ParallelDecisionsAdapter({ apiKey: config.openRouterApiKey }) : undefined);
  }

  async processEvent(event: NormalizedEvent): Promise<PolicyGateResult> {
    // Stage 1: Deterministic Pre-Filter
    const preFilterResult = deterministicPreFilter(event, this.config);
    if (!preFilterResult.passed && preFilterResult.immediateDecision) {
      const imm = preFilterResult.immediateDecision;
      const dummyContext = { event };
      const workKey = this.policyGate.computeSemanticWorkKey(dummyContext);

      return {
        action: imm.action,
        semanticWorkKey: workKey,
        intent: imm.intent,
        priority: 'low',
        reason: imm.reason,
        targetAgent: 'chatgpt-reviewer',
        isModelOverridden: false,
        metadata: {
          repository: event.target.repository,
          prNumber: event.target.prNumber,
          headSha: event.target.headSha,
          timestamp: new Date().toISOString()
        }
      };
    }

    // Stage 2: Context Enrichment
    const enrichedContext = await this.enricher.enrich(event);

    // Stage 2.5: Parallel Decisions Fast-Path Superpower
    if (this.decisionsAdapter) {
      try {
        const triageContext = {
          eventType: event.eventType,
          title: enrichedContext.pr?.title || (event.metadata?.title as string),
          bodySnippet: event.bodySnippet || enrichedContext.pr?.description,
          actor: event.actor.login,
          hasPromptContext: event.hasPromptContext
        };
        const triageResult = await this.decisionsAdapter.evaluateWebhookTriage(
          triageContext,
          this.config.parallelDecisionsActionableThreshold ?? 0.75
        );
        enrichedContext.parallelTriage = triageResult;

        // Early fast-path suppression for non-actionable routine dependency bumps with low risk
        if (!triageResult.isActionable && triageResult.changeType === 'routine_bump' && triageResult.riskScore <= 2) {
          const workKey = this.policyGate.computeSemanticWorkKey(enrichedContext);
          return {
            action: 'ignore',
            semanticWorkKey: workKey,
            intent: 'informational',
            priority: 'low',
            reason: `[Parallel Decisions Fast-Path] Suppressed non-actionable ${triageResult.changeType} (prob: ${triageResult.actionableProbability.toFixed(2)}, risk: ${triageResult.riskScore}/5).`,
            targetAgent: 'chatgpt-reviewer',
            isModelOverridden: false,
            metadata: {
              repository: event.target.repository,
              prNumber: event.target.prNumber,
              headSha: event.target.headSha,
              timestamp: new Date().toISOString()
            }
          };
        }
      } catch (decErr) {
        if (!enrichedContext.enrichmentErrors) enrichedContext.enrichmentErrors = [];
        enrichedContext.enrichmentErrors.push(`ParallelDecisions evaluation skipped: ${(decErr as Error).message}`);
      }
    }

    // Stage 3: Semantic Decision Engine
    const modelDecision = await this.decisionEngine.classify(enrichedContext);

    // Stage 4: Deduplication & Deterministic Policy Gate
    const workKey = this.policyGate.computeSemanticWorkKey(enrichedContext);
    const isAlreadyClaimed = this.claimedWorkKeys.has(workKey);

    const result = this.policyGate.evaluate(enrichedContext, modelDecision, isAlreadyClaimed);

    // If dispatch is approved, claim the work key to prevent duplicate review runs
    if (result.action === 'dispatch') {
      this.claimedWorkKeys.add(workKey);
    }

    return result;
  }

  isKeyClaimed(key: string): boolean {
    return this.claimedWorkKeys.has(key);
  }

  clearClaims(): void {
    this.claimedWorkKeys.clear();
  }
}
