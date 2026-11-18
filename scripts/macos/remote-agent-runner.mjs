#!/usr/bin/env node
// Compatibility entry point. Agent-specific behavior lives in its own folder.
import { main, validateRemoteJob } from "../../linear-agent-bridge/agents/trae/scripts/launch.mjs";
export { validateRemoteJob };
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch(error => { console.error("REMOTE_ERROR: " + error.message); process.exitCode = 1; });
}
