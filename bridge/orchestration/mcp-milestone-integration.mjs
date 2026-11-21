// ABR-99 — non-production, bridge-owned MCP → canonical ledger/checkpoint/inbox.
// No HTTP route, task dispatcher, GitHub/Linear client, or memU writer is
// instantiated here. Interactive sessions cannot be promoted to Linear jobs.
import { createHash } from 'node:crypto';
import { sanitizeCheckpointText } from '../../memory/active-task-memory.mjs';
import { verifiedRecoveryPreamble } from '../../memory/verified-recovery.mjs';
import { resolveGithubReviewDestination } from '../../integrations/github-events.mjs';

const IDENT = /^[A-Za-z0-9_./:@-]{1,256}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = new Set(['running', 'launching', 'awaiting_external']);
const VALID_OUTCOMES = new Set(['completed', 'failed', 'cancelled']);
const NOW_MAX_MS = 60 * 60_000;

function id(value) {
  return typeof value === 'string' && IDENT.test(value);
}
function sanitizedSummary(value, max = 240) {
  if (typeof value !== 'string' || !value.trim() ||
      Buffer.byteLength(value, 'utf8') > 4_096)
    throw Error('INVALID_MILESTONE_SUMMARY');
  return sanitizeCheckpointText(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ')
    .trim().slice(0, max);
}
function scopedJob(job, grant) {
  if (!job || !grant || !STATES.has(job.state) ||
      job.key !== grant.jobKey ||
      job.agent !== grant.agentId ||
      job.tenantId !== grant.tenantId ||
      job.repositoryRoot !== grant.repositoryRoot ||
      job.repositoryId !== grant.repositoryId ||
      job.issueId !== grant.issueId ||
      job.agentSessionId !== grant.sessionId ||
      job.executionHost !== grant.hostId ||
      job.branch !== grant.branch)
    throw Error('JOB_LEDGER_SCOPE_MISMATCH');
  return job;
}
function validateTrustedAdmission(grant, now) {
  if (!grant || grant.mode !== 'linear' ||
      !['coding', 'review'].includes(grant.role) ||
      !['antigravity', 'trae', 'chatgpt-cli', 'opencode', 'gemini',
        'kilo', 'mistral', 'local'].includes(grant.agentId) ||
      !['rebel-server', 'macos-runtime'].includes(grant.hostId) ||
      !id(grant.tenantId) || !id(grant.jobKey) ||
      !id(grant.sessionId) || !id(grant.issueId) ||
      !id(grant.branch) || !REPO.test(grant.repositoryId ?? '') ||
      typeof grant.repositoryRoot !== 'string' ||
      !grant.repositoryRoot.startsWith('/') ||
      grant.repositoryRoot === '/' ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= now() ||
      grant.expiresAt > now() + NOW_MAX_MS)
    throw Error('UNVERIFIED_LINEAR_ADMISSION');
  return Object.freeze({
    mode: 'linear', role: grant.role, agentId: grant.agentId,
    hostId: grant.hostId, tenantId: grant.tenantId,
    jobKey: grant.jobKey, sessionId: grant.sessionId,
    issueId: grant.issueId, branch: grant.branch,
    repositoryId: grant.repositoryId,
    repositoryRoot: grant.repositoryRoot, expiresAt: grant.expiresAt,
  });
}

export function createMcpBridgeIntegration({
  jobStore, memory, reviewInbox, verifyAdmittedJob, verifyToolReceipt,
  verifySubmittedPr = null, submissionCoordinator = null,
  verifyD5Handoff = null, reviewRoutingConfig = null,
  now = () => Date.now(),
}) {
  if (typeof jobStore?.get !== 'function' ||
      typeof memory?.read !== 'function' ||
      typeof memory?.update !== 'function' ||
      typeof reviewInbox?.enqueue !== 'function' ||
      typeof verifyAdmittedJob !== 'function' ||
      typeof verifyToolReceipt !== 'function' ||
      typeof now !== 'function')
    throw TypeError('CANONICAL_BRIDGE_ADAPTERS_REQUIRED');
  if (submissionCoordinator &&
      (typeof submissionCoordinator.submit !== 'function' ||
       typeof verifySubmittedPr !== 'function' ||
       !reviewRoutingConfig || typeof reviewRoutingConfig !== 'object'))
    throw TypeError('REAL_SUBMISSION_AND_REVIEW_VERIFIERS_REQUIRED');

  // A frozen handle is never a credential. Only trusted verification mints
  // the WeakMap binding; tool arguments, process environment and transcripts
  // cannot manufacture one.
  const grants = new WeakMap();
  async function bindAdmittedJob(admission) {
    const verified = validateTrustedAdmission(
      await verifyAdmittedJob(admission), now,
    );
    scopedJob(await jobStore.get(verified.jobKey), verified);
    const handle = Object.freeze(Object.create(null));
    grants.set(handle, verified);
    return handle;
  }
  async function requireJob(handle) {
    const grant = grants.get(handle);
    if (!grant || grant.expiresAt <= now())
      throw Error('MCP_JOB_CAPABILITY_REQUIRED');
    const job = scopedJob(await jobStore.get(grant.jobKey), grant);
    return { grant, job };
  }
  async function recordToolMilestone(handle, receipt) {
    const { grant, job } = await requireJob(handle);
    const verified = await verifyToolReceipt(receipt, Object.freeze({
      jobKey: grant.jobKey, sessionId: grant.sessionId,
      tenantId: grant.tenantId, agentId: grant.agentId,
      hostId: grant.hostId,
    }));
    if (!verified || verified.jobKey !== grant.jobKey ||
        verified.sessionId !== grant.sessionId ||
        verified.hostId !== grant.hostId ||
        verified.agentId !== grant.agentId ||
        verified.tenantId !== grant.tenantId ||
        !id(verified.toolCallId) || !id(verified.toolName) ||
        !VALID_OUTCOMES.has(verified.outcome))
      throw Error('UNVERIFIED_TOOL_COMPLETION');
    const summary = sanitizedSummary(verified.summary);
    const at = new Date(now()).toISOString();
    const entry = {
      at, kind: 'tool', toolCallId: verified.toolCallId,
      toolName: verified.toolName,
      outcome: verified.outcome,
      summary, jobKey: grant.jobKey, hostId: grant.hostId,
      sessionId: grant.sessionId,
      source: 'bridge-verified-tool-receipt',
      // Execution completion was verified; narrative content remains
      // informational, not test proof, issue authority or dispatch input.
      trustedForDispatch: false,
    };
    // Read and compare under the existing active-task-memory file lock and
    // revision CAS. There is no second checkpoint schema or lifecycle writer.
    const receiptHash = createHash('sha256').update(JSON.stringify([
      grant.jobKey, grant.sessionId, grant.hostId,
      verified.toolCallId,
    ])).digest('hex');
    let record;
    try {
      record = await memory.update(grant.repositoryRoot, grant.issueId, prior => {
        if (!prior || prior.lastJobKey !== grant.jobKey ||
            prior.lastSessionId !== grant.sessionId ||
            prior.tenantId !== grant.tenantId ||
            prior.agentId !== grant.agentId ||
            prior.repositoryRoot !== grant.repositoryRoot ||
            prior.issueId !== grant.issueId ||
            prior.hostId !== grant.hostId ||
            prior.branch !== grant.branch ||
            prior.repositoryId !== grant.repositoryId)
          throw Error('CHECKPOINT_SCOPE_MISMATCH');
        const receipts = prior.recordedToolReceipts ?? [];
        if (!Array.isArray(receipts) ||
            receipts.some(item => !HASH.test(item)) ||
            receipts.length > 256)
          throw Error('INVALID_MILESTONE_RECEIPT_HISTORY');
        if (receipts.includes(receiptHash)) {
          const priorEntry = prior.progress?.find(item =>
            item.toolCallId === verified.toolCallId);
          if (priorEntry && (priorEntry.outcome !== verified.outcome ||
              priorEntry.toolName !== verified.toolName ||
              priorEntry.summary !== summary))
            throw Error('TOOL_RECEIPT_COLLISION');
          // Throw inside the existing checkpoint lock to avoid incrementing
          // CAS revision for duplicate calls.
          throw Error('MILESTONE_ALREADY_RECORDED');
        }
        // Fail closed rather than silently forgetting old hashes and
        // letting replayed tool receipts be accepted as new milestones.
        if (receipts.length >= 256) throw Error('MILESTONE_RECEIPT_CAPACITY');
        return {
          expectedRevision: prior.revision,
          progress: [...(prior.progress ?? []), entry].slice(-6),
          recordedToolReceipts: [...receipts, receiptHash],
          lastProgressAt: at,
        };
      });
    } catch (error) {
      if (error.message === 'MILESTONE_ALREADY_RECORDED')
        return Object.freeze({ recorded: false, duplicate: true });
      if (error.code === 'ECONFLICT')
        throw Error('STALE_CHECKPOINT_REVISION');
      throw error;
    }
    return Object.freeze({ recorded: true, duplicate: false,
      revision: record.revision, milestone: entry });
  }
  async function recoveryHandoff(handle) {
    const { grant } = await requireJob(handle);
    const checkpoint = await memory.read(grant.repositoryRoot, grant.issueId);
    if (checkpoint && (checkpoint.lastJobKey !== grant.jobKey ||
        checkpoint.lastSessionId !== grant.sessionId ||
        checkpoint.hostId !== grant.hostId ||
        checkpoint.branch !== grant.branch ||
        checkpoint.repositoryId !== grant.repositoryId))
      throw Error('STALE_CHECKPOINT_IDENTITY');
    const text = verifiedRecoveryPreamble(checkpoint, {
      tenantId: grant.tenantId, agentId: grant.agentId,
      repositoryRoot: grant.repositoryRoot, issueId: grant.issueId,
    }, { now: now() });
    return Object.freeze({
      jobKey: grant.jobKey, issueId: grant.issueId,
      repositoryId: grant.repositoryId, hostId: grant.hostId,
      agentId: grant.agentId, context: text,
      authority: 'non-authoritative-checkpoint-data',
      // Existing C3/C5/D5 context bundle resolver remains separately owned.
      // This method returns no executable commands, tokens or file grants.
    });
  }
  async function sourceLinkedHandoff(handle, envelope) {
    const { grant } = await requireJob(handle);
    if (typeof verifyD5Handoff !== 'function')
      throw Error('CANONICAL_D5_VERIFIER_NOT_CONFIGURED');
    // Use the existing D5 source-pinned CLI contract, not a second resolver.
    // A caller-supplied envelope is data; only the trusted injected verifier
    // can attest it with --check-source against the immutable Git commit.
    if (!envelope || typeof envelope !== 'object' ||
        envelope.handoffVersion !== 1 ||
        envelope.repository !== grant.repositoryId ||
        !SHA.test(envelope.repoCommit ?? '') ||
        !HASH.test(envelope.handoffSha256 ?? '') ||
        !HASH.test(envelope.contextSha256 ?? '') ||
        !HASH.test(envelope.messageSha256 ?? '') ||
        envelope.contextBundle?.gitHeadSha !== envelope.repoCommit ||
        typeof envelope.message !== 'string' ||
        !envelope.message.trim() ||
        Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 2_000_000)
      throw Error('INVALID_D5_CONTEXT_ENVELOPE');
    const verified = await verifyD5Handoff(envelope, Object.freeze({
      repositoryId:grant.repositoryId, repositoryRoot:grant.repositoryRoot,
      issueId:grant.issueId, jobKey:grant.jobKey,
      hostId:grant.hostId, sessionId:grant.sessionId,
    }));
    if (verified !== true) throw Error('D5_SOURCE_VERIFICATION_REQUIRED');
    return Object.freeze({
      kind:'source-linked-context', version:1, repository:grant.repositoryId,
      repoCommit:envelope.repoCommit, handoffSha256:envelope.handoffSha256,
      // The complete envelope, not a lone hash, travels to the next session.
      envelope, authority:'portable-readme-context-not-execution',
    });
  }
  async function submitWork(handle, { issueId, summary } = {}) {
    const { grant } = await requireJob(handle);
    if (grant.role !== 'coding') throw Error('CODING_JOB_REQUIRED');
    if (issueId !== grant.issueId) throw Error('SUBMISSION_ISSUE_MISMATCH');
    const safeSummary = sanitizedSummary(summary, 1_500);
    if (!submissionCoordinator)
      throw Error('SUBMISSION_COORDINATOR_NOT_CONFIGURED');
    // The ABR-17 coordinator, never this MCP adapter, owns GitHub, Linear,
    // Worker callback, review gates and one-PR-per-branch idempotency.
    const submitted = await submissionCoordinator.submit(Object.freeze({
      jobKey: grant.jobKey, sessionId: grant.sessionId,
      repositoryId: grant.repositoryId, repositoryRoot: grant.repositoryRoot,
      tenantId: grant.tenantId, agentId: grant.agentId,
      issueId: grant.issueId, branch: grant.branch,
      hostId: grant.hostId, summary: safeSummary,
    }));
    const verified = await verifySubmittedPr(submitted, Object.freeze({
      jobKey: grant.jobKey, issueId: grant.issueId,
      repositoryId: grant.repositoryId, branch: grant.branch,
    }));
    if (!verified || verified.status !== 'in_review' ||
        verified.issueId !== grant.issueId ||
        verified.repository !== grant.repositoryId ||
        verified.branch !== grant.branch ||
        !Number.isSafeInteger(verified.number) ||
        verified.number < 1 || !SHA.test(verified.headSha) ||
        verified.url !== `https://github.com/${verified.repository}/pull/${verified.number}` ||
        verified.checksPassed !== true)
      throw Error('UNVERIFIED_SUBMISSION_OUTCOME');
    const destination = resolveGithubReviewDestination(
      reviewRoutingConfig, grant.repositoryId,
    );
    if (!destination.ok) throw Error('REVIEW_DESTINATION_UNAVAILABLE');
    // Canonical review inbox: durable dedupe uses repo + PR + action + head.
    // Queued != notification sent, reviewer started, acknowledged or Done.
    const event = Object.freeze({
      event: 'pull_request', action: 'ready_for_review',
      repository: grant.repositoryId, number: verified.number,
      url: verified.url, headSha: verified.headSha, draft: false,
    });
    const queued = await reviewInbox.enqueue(event, {
      source: 'chatgpt', destination,
    });
    return Object.freeze({
      state: 'in_review', reviewer: 'chatgpt-user-review',
      reviewQueued: true, reviewCreated: queued.created,
      reviewId: queued.record.reviewId,
      issueId: grant.issueId, repository: grant.repositoryId,
      prNumber: verified.number, headSha: verified.headSha,
      // Worker completion is independently tracked by ABR-17; never
      // misreport GitHub/Linear write or session close as a review ACK.
      reviewerAcknowledged: false, issueCompleted: false,
    });
  }
  return Object.freeze({
    bindAdmittedJob, recordToolMilestone, recoveryHandoff,
    sourceLinkedHandoff, submitWork,
    revoke: handle => grants.delete(handle),
  });
}
