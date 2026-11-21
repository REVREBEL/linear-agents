// ABR-98 — source-only MCP discovery/dispatch policy.
// The 50-name matrix is the reviewed reconciliation contract, NOT a claim
// that every handler has been implemented. No production relay imports this.
// A tool is advertised only if an actual, trusted handler was registered.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const PARITY = JSON.parse(readFileSync(new URL('../../../docs/audits/mcp/tool-parity.json', import.meta.url), 'utf8'));
const NAMES = new Set(PARITY.tools.map(entry => entry.name));
const DISALLOWED = new Set([
  'call_plugin_tool', 'list_plugin_tools', 'request_plugin_install',
  'search_mcp_registry', 'prepare_file_transfer', 'send_file_transfer',
  'receive_file_transfer',
]);
const ADMIN = new Set(['set_config_value', 'shutdown', 'review_device_call', 'delete_file']);
const DOCUMENT = new Set(['write_pdf']);
const WRITE = new Set(['write_file', 'edit_block', 'move_file', 'create_directory', 'ast_rewrite']);
const EXECUTE = new Set([
  'run_command', 'start_process', 'interact_with_process', 'kill_process',
  'force_terminate', 'spawn_job', 'run_parallel', 'cancel_job',
]);
const PROFILE_ORDER = ['core', 'focused', 'full'];
const CORE = new Set(['list_devices', 'read_file', 'get_file_info', 'list_directory', 'get_config']);
const FOCUSED = new Set([...CORE,
  'who_am_i', 'read_multiple_files', 'start_search', 'get_more_search_results',
  'stop_search', 'list_searches', 'git_status', 'git_diff', 'git_log',
  'ast_search', 'run_command', 'start_process', 'read_process_output',
  'interact_with_process', 'list_sessions', 'get_job', 'list_jobs', 'wait_jobs',
  'spawn_job', 'cancel_job',
]);
const NAME = /^[a-zA-Z0-9_.:-]{1,192}$/;
const ID = /^[a-zA-Z0-9_.:@-]{1,192}$/;
const LIMIT_JSON = 64 * 1024;

const p = (type, more = {}) => ({ type, ...more });
const obj = (properties = {}, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const DEVICE = { deviceId: p('string', { minLength: 1, maxLength: 128 }) };
const WORKSPACE = {
  workspaceId: p('string', { minLength: 1, maxLength: 64 }),
};
const PATH = { path: p('string', { minLength: 1, maxLength: 4_096 }) };
const SCHEMAS = Object.freeze({
  list_devices: obj(),
  read_file: obj({ ...DEVICE, ...PATH,
    offset: p('integer', { minimum: 0 }),
    length: p('integer', { minimum: 1, maximum: 1_000 }),
  }, ['deviceId', 'path']),
  get_config: obj(DEVICE),
  who_am_i: obj(),
  get_file_info: obj({ ...DEVICE, ...PATH }, ['path']),
  list_directory: obj({ ...DEVICE, ...PATH, depth: p('integer', { minimum: 0, maximum: 3 }) }, ['path']),
  read_multiple_files: obj({ ...DEVICE,
    paths: p('array', { items: PATH.path, minItems: 1, maxItems: 20 }),
  }, ['paths']),
  git_status: obj({ ...WORKSPACE, ...DEVICE }, ['workspaceId']),
  git_diff: obj({ ...WORKSPACE, ...DEVICE,
    pathspec: p('string', { maxLength: 512 }),
    staged: p('boolean'),
  }, ['workspaceId']),
  git_log: obj({ ...WORKSPACE, ...DEVICE,
    limit: p('integer', { minimum: 1, maximum: 50 }),
  }, ['workspaceId']),
  ast_search: obj({ ...WORKSPACE, ...DEVICE, ...PATH,
    syntax: p('string', { enum: ['javascript', 'typescript', 'tsx', 'jsx'] }),
    kind: p('string', { minLength: 1, maxLength: 60 }),
    symbol: p('string', { minLength: 1, maxLength: 128 }),
    maxResults: p('integer', { minimum: 1, maximum: 100 }),
  }, ['workspaceId', 'path', 'kind']),
  ast_rewrite: obj({ ...WORKSPACE, ...DEVICE, ...PATH,
    syntax: p('string', { enum: ['javascript', 'typescript', 'tsx', 'jsx'] }),
    kind: p('string', { minLength: 1, maxLength: 60 }),
    symbol: p('string', { minLength: 1, maxLength: 128 }),
    replacement: p('string', { maxLength: 16_384 }),
    expectedSha256: p('string', { pattern: '^[a-f0-9]{64}$' }),
    dryRun: p('boolean'),
  }, ['workspaceId', 'path', 'kind', 'replacement']),
  start_process: obj({ ...DEVICE, ...WORKSPACE, command: p('object'),
    durationMs: p('integer', { minimum: 200, maximum: 120_000 }),
  }, ['workspaceId', 'command']),
  run_command: obj({ ...DEVICE, ...WORKSPACE, command: p('object'),
    durationMs: p('integer', { minimum: 200, maximum: 120_000 }),
  }, ['workspaceId', 'command']),
  write_pdf: obj({ ...DEVICE, ...PATH, ...WORKSPACE,
    content: { oneOf: [
      p('string', { maxLength: 100_000 }),
      p('array', { minItems: 1, maxItems: 64,
        items: p('object') }),
    ] },
    outputPath: p('string', { maxLength: 4_096 }),
    options: p('object'),
  }, ['path', 'content']),
  set_config_value: obj({ ...DEVICE, key: p('string'), value: p('string') }, ['key', 'value']),
  shutdown: obj(DEVICE),
  delete_file: obj({ ...DEVICE, ...PATH }, ['path']),
  review_device_call: obj({ ...DEVICE, callId: p('string'), decision: p('string', { enum: ['approve', 'deny'] }) }, ['callId','decision']),
});

function validateValue(value, rule) {
  if (rule.oneOf) {
    if (!rule.oneOf.some(candidate => {
      try { validateValue(value,candidate); return true; }
      catch { return false; }
    })) throw Error('INVALID_PARAMS');
    return;
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < (rule.minItems ?? 0) ||
        value.length > (rule.maxItems ?? 256))
      throw Error('INVALID_PARAMS');
    if (rule.items) for (const item of value) validateValue(item, rule.items);
  } else if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error('INVALID_PARAMS');
    if (rule.additionalProperties === false)
      assertSchema(value, rule);
  } else if (rule.type === 'integer') {
    if (!Number.isInteger(value) ||
        value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))
      throw Error('INVALID_PARAMS');
  } else if (typeof value !== rule.type) throw Error('INVALID_PARAMS');
  if (typeof value === 'string' && (
    value.length < (rule.minLength ?? 0) ||
    value.length > (rule.maxLength ?? 1_000_000) ||
    value.includes('\0') ||
    rule.enum && !rule.enum.includes(value) ||
    rule.pattern && !new RegExp(rule.pattern).test(value)))
    throw Error('INVALID_PARAMS');
}
function assertSchema(input, schema) {
  if (!schema || !input || typeof input !== 'object' || Array.isArray(input))
    throw Error('INVALID_PARAMS');
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(input, key)) throw Error('INVALID_PARAMS');
  }
  for (const [key, value] of Object.entries(input)) {
    const rule = schema.properties[key];
    if (!rule) throw Error('INVALID_PARAMS');
    validateValue(value,rule);
  }
  if (Buffer.byteLength(JSON.stringify(input)) > LIMIT_JSON)
    throw Error('INVALID_PARAMS');
}

function scopeOf(tool) {
  if (DISALLOWED.has(tool)) return 'prohibited';
  if (ADMIN.has(tool)) return 'admin';
  if (DOCUMENT.has(tool)) return 'document:write';
  if (WRITE.has(tool)) return 'workspace:write';
  if (EXECUTE.has(tool)) return 'process:execute';
  return 'workspace:read';
}
function inProfile(tool, profile) {
  if (profile === 'core') return CORE.has(tool);
  if (profile === 'focused') return FOCUSED.has(tool);
  return profile === 'full';
}
const frozen = x => Object.freeze(x);

export function createMcpToolProfiles({ handlers, schemas = {}, verifySession,
  checkLive = () => true, now = () => Date.now(), allowAdmin = false }) {
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers) ||
      typeof verifySession !== 'function' || typeof checkLive !== 'function')
    throw TypeError('TRUSTED_TOOL_HANDLERS_AND_SESSION_VERIFIER_REQUIRED');
  const definitions = new Map();
  for (const [name, handler] of Object.entries(handlers)) {
    if (!NAMES.has(name) || DISALLOWED.has(name) ||
        ADMIN.has(name) && !allowAdmin || typeof handler !== 'function')
      throw Error('UNAPPROVED_TOOL_HANDLER');
    const inputSchema = schemas[name] ?? SCHEMAS[name];
    if (!inputSchema || inputSchema.type !== 'object' ||
        inputSchema.additionalProperties !== false)
      throw Error('MISSING_REVIEWED_INPUT_SCHEMA');
    definitions.set(name, frozen({
      name,
      description: 'Operator-approved, device-scoped ' + name.replaceAll('_', ' ') + ' operation',
      inputSchema,
    }));
  }
  const sessions = new WeakMap();
  function register(credential) {
    const grant = verifySession(credential);
    if (!grant || typeof grant !== 'object' || !ID.test(grant.subject ?? '') ||
        !ID.test(grant.tenantId ?? '') || !ID.test(grant.sessionId ?? '') ||
        !ID.test(grant.deviceId ?? '') ||
        !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now() ||
        grant.expiresAt > now() + 3_600_000 ||
        !Array.isArray(grant.allowedTools) ||
        !Array.isArray(grant.capabilities) ||
        !Array.isArray(grant.allowedWorkspaces) ||
        !PROFILE_ORDER.includes(grant.profile ?? 'core'))
      throw Error('UNVERIFIED_TOOL_SESSION');
    const validateSet = values => {
      if (values.some(item => !NAME.test(item)) || values.length > 128)
        throw Error('INVALID_TOOL_GRANTS');
      return new Set(values);
    };
    const handle = frozen(Object.create(null));
    sessions.set(handle, {
      subject: grant.subject, tenantId: grant.tenantId, sessionId: grant.sessionId,
      deviceId: grant.deviceId, expiresAt: grant.expiresAt,
      allowedTools: validateSet(grant.allowedTools),
      capabilities: validateSet(grant.capabilities),
      workspaces: validateSet(grant.allowedWorkspaces),
      profile: grant.profile ?? 'core',
    });
    return handle;
  }
  function requireSession(handle) {
    const session = sessions.get(handle);
    if (!session || session.expiresAt <= now() || checkLive(session) !== true)
      throw Error('UNAUTHORIZED_TOOL_SESSION');
    return session;
  }
  function permitted(session, name, args) {
    const capability = scopeOf(name);
    return definitions.has(name) && session.allowedTools.has(name) &&
      session.capabilities.has(capability) &&
      (args?.deviceId === undefined || args.deviceId === session.deviceId) &&
      (args?.workspaceId === undefined || session.workspaces.has(args.workspaceId));
  }
  function listTools(handle) {
    const session = requireSession(handle);
    return [...definitions.values()].filter(def => inProfile(def.name, session.profile) &&
        permitted(session, def.name, {})).sort((a,b) => a.name.localeCompare(b.name));
  }
  async function invoke(handle, name, args = {}) {
    const session = requireSession(handle);
    // Never use profile visibility as the permission check. An exact-name
    // hidden invocation requires the same independent tool+capability grant.
    if (!permitted(session, name, args)) throw Error('TOOL_NOT_AUTHORIZED');
    const descriptor = definitions.get(name);
    assertSchema(args, descriptor.inputSchema);
    const result = await handlers[name](frozen({ ...args }), frozen({
      subject: session.subject, tenantId: session.tenantId,
      sessionId: session.sessionId, deviceId: session.deviceId,
      allowedWorkspaces: frozen([...session.workspaces]),
    }));
    return result;
  }
  return frozen({
    register, listTools, invoke, revoke: handle => sessions.delete(handle),
    inspect: () => frozen({
      approved: [...definitions.keys()].sort(),
      unimplementedConnected: PARITY.tools.filter(t => t.connectedRemoteDesktopCommander &&
        !definitions.has(t.name)).map(t=>t.name).sort(),
      denied: [...DISALLOWED].sort(),
    }),
  });
}

export function measureToolProfileFootprint(catalog, handles, iterations = 100) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000)
    throw TypeError('INVALID_BENCHMARK_ITERATIONS');
  const results = {};
  for (const [profile, handle] of Object.entries(handles)) {
    if (!PROFILE_ORDER.includes(profile)) throw Error('UNKNOWN_PROFILE');
    const begin = performance.now();
    let tools;
    for (let i = 0; i < iterations; i++) tools = catalog.listTools(handle);
    const elapsed = (performance.now() - begin) / iterations;
    const encoded = JSON.stringify({ tools });
    results[profile] = frozen({
      tools: tools.length, schemaBytes: Buffer.byteLength(encoded),
      tokensApprox: Math.ceil(encoded.length / 4),
      avgDiscoveryMs: Number(elapsed.toFixed(5)),
    });
  }
  return frozen(results);
}
export const PARITY_COUNTS = frozen({ ...PARITY.counts });
export const TOOL_NAMES = frozen([...NAMES].sort());
export const TOOL_PROFILE_LABELS = frozen([...PROFILE_ORDER]);
