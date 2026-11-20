// ABR-98 representative schema footprint. This uses registered mock
// handlers to measure the REAL gateway JSON emitted for each profile.
// It does not claim the 30 connected tools all have golden runtime handlers.
import { createMcpToolProfiles, measureToolProfileFootprint } from
  '../bridge/server/mcp-relay/tool-profiles.mjs';

const names = [
  'list_devices','read_file','get_file_info','list_directory','get_config',
  'git_status','git_diff','git_log','ast_search','ast_rewrite','write_pdf',
  'start_process','run_command',
];
const handlers = Object.fromEntries(names.map(name=>[name,()=>null]));
const marker = Object.freeze({});
const profiles = ['core','focused','full'];
const gateway = createMcpToolProfiles({
  handlers,
  verifySession: ticket => ticket?.marker === marker ? {
    subject:'benchmark@example.invalid',tenantId:'benchmark',
    sessionId:'fixture-session',deviceId:'fixture-host',
    expiresAt:2_000_000,
    profile:ticket.profile,
    allowedTools:names,
    capabilities:['workspace:read','workspace:write','process:execute','document:write'],
    allowedWorkspaces:['fixture-project'],
  } : null,
  now:()=>1_990_000,
});
const handles = Object.fromEntries(profiles.map(profile=>
  [profile,gateway.register({ marker,profile })]));
const result = measureToolProfileFootprint(gateway,handles,2_000);
process.stdout.write(JSON.stringify({
  description:'ABR-98 representative registered schema benchmark (mock handlers)',
  caveat:'Not a 30-tool runtime schema parity or live network latency benchmark',
  matrix:{connected:30,brcAgent:42,brcRelay:3,distinct:50},
  benchmark:result,
},null,2)+'\n');
