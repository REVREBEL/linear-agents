/**
 * REVREBEL Linear Agent Bridge — Environment-Aware Dispatch Router (ABR-1)
 *
 * Implements:
 * 1. Versioned Project -> Environment Registry Loader (routing.json v2)
 * 2. Strict Capability Boundaries (Ubuntu Dev, macOS Runtime, Cloudflare Edge, PostgreSQL/memU, Shared Core)
 * 3. Fail-Closed Project Resolution with .unrouted.json Diagnostics & Linear Error Activity formatting
 * 4. Extends and unifies host-routing (chooseExecutionHost, configuredProjectRoots, makeRemoteRoute, validateSshSettings)
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/* =========================================================================
 * 1. Host-Routing Primitives (Extended from canonical host-routing.mjs)
 * ========================================================================= */

const MAC_NAMES = new Set([
  'mac',
  'macos',
  'agent-location:mac',
  'agent-location:macos'
]);

const SERVER_NAMES = new Set([
  'bridge-server',
  'bridge server',
  'agent-location:bridge-server'
]);

export interface HostResolutionResult {
  ok: boolean;
  host?: 'bridge-server' | 'macos';
  source?: 'default' | 'linear-label';
  error?: string;
}

export function chooseExecutionHost(routing?: { agentLocation?: string }): HostResolutionResult {
  const label = routing?.agentLocation;
  if (label == null || label === '') {
    return { ok: true, host: 'bridge-server', source: 'default' };
  }
  const normalized = String(label).trim().toLowerCase();
  if (MAC_NAMES.has(normalized)) {
    return { ok: true, host: 'macos', source: 'linear-label' };
  }
  if (SERVER_NAMES.has(normalized)) {
    return { ok: true, host: 'bridge-server', source: 'linear-label' };
  }
  return {
    ok: false,
    error: `Unrecognized Agent Location label: "${label}". Must be Macos or Bridge Server.`
  };
}

export function configuredProjectRoots(env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}) {
  const linux = env.LINUX_PROJECTS_ROOT || env.PROJECTS_ROOT;
  const mac = env.OSX_PROJECTS_ROOT;
  return { linux, mac };
}

export function makeRemoteRoute({
  root,
  repository,
  scope = '.',
  launchFromScope = false
}: {
  root: string;
  repository: string;
  scope?: string;
  launchFromScope?: boolean;
}) {
  if (typeof root !== 'string' || !path.posix.isAbsolute(root) || root.includes('\0') || root.includes("'")) {
    throw Error('OSX_PROJECTS_ROOT must be an absolute macOS path');
  }
  if (!/^REVREBEL\/[a-zA-Z0-9._-]+$/.test(repository)) {
    throw Error('Invalid approved repository');
  }
  if (typeof scope !== 'string' || path.posix.isAbsolute(scope) || scope.includes('\0')) {
    throw Error('Invalid relative project scope');
  }
  const repositoryRoot = path.posix.resolve(root, repository.split('/')[1]);
  const scopePath = path.posix.resolve(repositoryRoot, scope);
  if (scopePath !== repositoryRoot && !scopePath.startsWith(repositoryRoot + '/')) {
    throw Error('Project scope escapes remote repository');
  }
  return {
    repositoryRoot,
    projectScope: scope,
    launchDirectory: launchFromScope ? scopePath : repositoryRoot
  };
}

export function validateSshSettings(env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}) {
  const host = env.MAC_SSH_HOST;
  if (!host || !/^[a-zA-Z0-9_.@-]+$/.test(host) || host.startsWith('-')) {
    throw Error('MAC_SSH_HOST must name a trusted SSH host or alias');
  }
  const nodeBin = env.MAC_NODE_BIN || 'node';
  if (!/^(?:node|\/[a-zA-Z0-9_./-]+)$/.test(nodeBin) || nodeBin.includes('..')) {
    throw Error('MAC_NODE_BIN must be node or an absolute trusted executable');
  }
  const roots = configuredProjectRoots(env);
  const runner =
    env.MAC_RUNNER_PATH ||
    path.posix.join(roots.mac || '', 'linear-agents', 'linear-agent-bridge/agents/trae/scripts/launch.mjs');
  if (!path.posix.isAbsolute(runner) || runner.includes('\n') || runner.includes('\0') || runner.includes("'")) {
    throw Error('MAC_RUNNER_PATH must be an absolute trusted macOS file path');
  }
  return { host, nodeBin, runner };
}

/* =========================================================================
 * 2. Environment-Aware Routing Registry & Capability Gating (ABR-1)
 * ========================================================================= */

export type EnvironmentTargetKey =
  | 'ubuntu_dev'
  | 'macos_runtime'
  | 'cloudflare_edge'
  | 'postgres_memory'
  | 'shared_core';

export interface EnvironmentDefinition {
  host: 'bridge-server' | 'macos' | 'cloudflare' | 'rebel-server';
  transport: 'local' | 'ssh' | 'gated_deploy';
  projectsRootEnv?: string;
  fallbackRoot?: string;
  sshHostEnv?: string;
  requiresManualApproval?: boolean;
  allowedOperations: string[];
}

export interface ProjectRoutingEntry {
  name: string;
  repository: string;
  targetEnvironment: EnvironmentTargetKey;
  defaultAgent?: string;
  supportedLocations?: ('bridge-server' | 'macos')[];
  capabilityRequirements?: string[];
  deploymentGate?: boolean;
  requiresSshKey?: string;
  scope?: string;
  conversationMode?: 'new-per-issue' | 'reuse-existing';
}

export interface RoutingConfigV2 {
  version: string;
  initiativeId?: string;
  initiativeName?: string;
  environments: Record<EnvironmentTargetKey, EnvironmentDefinition>;
  projects: Record<string, ProjectRoutingEntry>;
}

export interface LinearJobPayload {
  issueId: string;
  agentSessionId?: string;
  teamId?: string;
  requestedOperation?: 'code' | 'test' | 'deploy_worker' | 'migrate' | 'ui_render';
  routing?: {
    projectId?: string;
    projectName?: string;
    initiativeIds?: string[];
    agentLocation?: string;
  };
}

export interface RoutingSuccess {
  ok: true;
  environment: EnvironmentTargetKey;
  host: 'bridge-server' | 'macos' | 'cloudflare' | 'rebel-server';
  transport: 'local' | 'ssh' | 'gated_deploy';
  workspace: {
    repositoryRoot: string;
    launchDirectory: string;
    scope: string;
  };
  agent: string;
  conversationMode: 'new-per-issue' | 'reuse-existing';
  capabilities: string[];
  requiresApproval: boolean;
  sshSettings?: {
    host: string;
    nodeBin: string;
    runner: string;
  };
}

export interface RoutingFailure {
  ok: false;
  statusCode: 422 | 503;
  failureStage:
    | 'missing_project'
    | 'unmapped_project'
    | 'unsupported_location'
    | 'capability_mismatch'
    | 'unreachable_runner'
    | 'invalid_path';
  reason: string;
  unroutedDiagnostic: {
    filename: string;
    issueId: string;
    routing: Record<string, unknown> | null;
    reason: string;
    timestamp: string;
  };
  linearErrorActivity: {
    title: string;
    body: string;
  };
}

export type RoutingResolutionResult = RoutingSuccess | RoutingFailure;

export class EnvironmentRouter {
  private config: RoutingConfigV2;
  private env: Record<string, string | undefined>;

  /**
   * Initializes the EnvironmentRouter with an external configuration.
   * Fails closed if the configuration file is missing, unreadable, or invalid.
   *
   * @param configOrPath Path to routing.json or a pre-parsed RoutingConfigV2 object.
   * @param env Environment variables (defaults to process.env)
   */
  constructor(
    configOrPath: string | RoutingConfigV2,
    env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}
  ) {
    if (!configOrPath) {
      throw new Error(
        'Routing configuration required: must provide either an absolute/relative path to routing.json or a valid RoutingConfigV2 object.'
      );
    }

    if (typeof configOrPath === 'string') {
      try {
        const fileContent = fs.readFileSync(configOrPath, 'utf8');
        this.config = JSON.parse(fileContent);
      } catch (err) {
        throw new Error(
          `Failed to load routing configuration from "${configOrPath}": ${(err as Error).message}`
        );
      }
    } else {
      this.config = configOrPath;
    }

    if (!this.config || typeof this.config !== 'object') {
      throw new Error('Invalid routing configuration: configuration must be an object.');
    }
    if (!this.config.environments || typeof this.config.environments !== 'object') {
      throw new Error('Invalid routing configuration: "environments" dictionary is required.');
    }
    if (!this.config.projects || typeof this.config.projects !== 'object') {
      throw new Error('Invalid routing configuration: "projects" dictionary is required.');
    }

    this.env = env;
  }

  resolve(payload: LinearJobPayload): RoutingResolutionResult {
    const issueId = payload.issueId || 'unknown_issue';
    const routing = payload.routing;

    // 1. Validate structured routing presence
    if (!routing || !routing.projectId) {
      return this.failClosed(
        issueId,
        routing ?? null,
        422,
        'missing_project',
        'Missing structured Linear project ID; no implicit fallback permitted under ABR-1.'
      );
    }

    const projectId = routing.projectId;
    const projectEntry = this.config.projects[projectId];

    // 2. Validate project mapping in registry
    if (!projectEntry) {
      return this.failClosed(
        issueId,
        routing,
        422,
        'unmapped_project',
        `Unmapped Linear project UUID: ${projectId}. Rejecting dispatch to prevent arbitrary host execution.`
      );
    }

    // 3. Resolve execution host label
    const hostResolution = chooseExecutionHost(routing);
    if (!hostResolution.ok) {
      return this.failClosed(
        issueId,
        routing,
        422,
        'unsupported_location',
        hostResolution.error || 'Invalid Agent Location label.'
      );
    }

    const requestedHost = hostResolution.host as 'bridge-server' | 'macos';
    const supportedLocations = projectEntry.supportedLocations || ['bridge-server'];

    // 4. Verify host capability against project rules
    if (!supportedLocations.includes(requestedHost)) {
      return this.failClosed(
        issueId,
        routing,
        422,
        'unsupported_location',
        `Location '${requestedHost}' is not authorized for project '${projectEntry.name}'. Supported: [${supportedLocations.join(', ')}].`
      );
    }

    const envDef = this.config.environments[projectEntry.targetEnvironment];
    if (!envDef) {
      return this.failClosed(
        issueId,
        routing,
        503,
        'capability_mismatch',
        `Environment definition '${projectEntry.targetEnvironment}' missing from registry.`
      );
    }

    // 5. Capability Gate: Gated deployments (Cloudflare / Production)
    const op = payload.requestedOperation || 'code';
    if (projectEntry.deploymentGate || op === 'deploy_worker') {
      if (envDef.requiresManualApproval) {
        return {
          ok: true,
          environment: projectEntry.targetEnvironment,
          host: envDef.host,
          transport: envDef.transport,
          workspace: {
            repositoryRoot: projectEntry.repository,
            launchDirectory: projectEntry.repository,
            scope: projectEntry.scope || '.'
          },
          agent: projectEntry.defaultAgent || 'chatgpt-cli',
          conversationMode: projectEntry.conversationMode || 'new-per-issue',
          capabilities: envDef.allowedOperations,
          requiresApproval: true
        };
      }
    }

    // 6. Resolve Workspace Root dynamically from verified environment
    const roots = configuredProjectRoots(this.env);
    const scope = projectEntry.scope || '.';

    if (requestedHost === 'macos') {
      const macRoot = roots.mac;
      if (!macRoot) {
        return this.failClosed(
          issueId,
          routing,
          503,
          'unreachable_runner',
          'OSX_PROJECTS_ROOT is not configured on bridge host for macOS dispatch.'
        );
      }

      let sshSettings;
      try {
        sshSettings = validateSshSettings(this.env);
      } catch (err) {
        return this.failClosed(
          issueId,
          routing,
          503,
          'unreachable_runner',
          `SSH settings validation failed: ${(err as Error).message}`
        );
      }

      try {
        const remoteRoute = makeRemoteRoute({
          root: macRoot,
          repository: projectEntry.repository,
          scope,
          launchFromScope: false
        });

        return {
          ok: true,
          environment: projectEntry.targetEnvironment,
          host: 'macos',
          transport: 'ssh',
          workspace: {
            repositoryRoot: remoteRoute.repositoryRoot,
            launchDirectory: remoteRoute.launchDirectory,
            scope: remoteRoute.projectScope
          },
          agent: projectEntry.defaultAgent || 'trae',
          conversationMode: projectEntry.conversationMode || 'reuse-existing',
          capabilities: envDef.allowedOperations,
          requiresApproval: false,
          sshSettings
        };
      } catch (err) {
        return this.failClosed(
          issueId,
          routing,
          422,
          'invalid_path',
          `Remote path containment failure: ${(err as Error).message}`
        );
      }
    }

    // Linux Local Execution
    const linuxRoot = roots.linux || envDef.fallbackRoot;
    if (!linuxRoot) {
      return this.failClosed(
        issueId,
        routing,
        503,
        'unreachable_runner',
        'Neither LINUX_PROJECTS_ROOT nor PROJECTS_ROOT is configured in environment.'
      );
    }

    const repoDirName = projectEntry.repository.split('/')[1] || projectEntry.repository;
    const repositoryRoot = path.posix.resolve(linuxRoot, repoDirName);
    const scopePath = path.posix.resolve(repositoryRoot, scope);

    // Confinement check
    if (scopePath !== repositoryRoot && !scopePath.startsWith(repositoryRoot + '/')) {
      return this.failClosed(
        issueId,
        routing,
        422,
        'invalid_path',
        `Project scope '${scope}' escapes resolved repository root '${repositoryRoot}'.`
      );
    }

    return {
      ok: true,
      environment: projectEntry.targetEnvironment,
      host: envDef.host,
      transport: envDef.transport,
      workspace: {
        repositoryRoot,
        launchDirectory: scopePath,
        scope
      },
      agent: projectEntry.defaultAgent || 'antigravity',
      conversationMode: projectEntry.conversationMode || 'new-per-issue',
      capabilities: envDef.allowedOperations,
      requiresApproval: false
    };
  }

  private failClosed(
    issueId: string,
    routing: Record<string, unknown> | null,
    statusCode: 422 | 503,
    failureStage: RoutingFailure['failureStage'],
    reason: string
  ): RoutingFailure {
    const rawHash = createHash('sha256')
      .update(`${issueId}:${JSON.stringify(routing)}:${reason}`)
      .digest('hex');
    const filename = `${rawHash}.unrouted.json`;

    return {
      ok: false,
      statusCode,
      failureStage,
      reason,
      unroutedDiagnostic: {
        filename,
        issueId,
        routing,
        reason,
        timestamp: new Date().toISOString()
      },
      linearErrorActivity: {
        title: 'Agent dispatch rejected by environment router',
        body: `### ⚠️ Routing Verification Failure (ABR-1)\n- **Reason:** ${reason}\n- **Stage:** \`${failureStage}\`\n- **Issue ID:** \`${issueId}\`\n- **Diagnostic File:** \`${filename}\`\n\n*Dispatch halted safely to protect production environments.*`
      }
    };
  }
}
