#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const MAX_INPUT_BYTES = 256 * 1024;

async function readInput() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error("Hook input is too large");
  }
  return input.trim() ? JSON.parse(input) : {};
}

async function findContext(start) {
  let current = path.resolve(start || process.cwd());
  for (;;) {
    const candidate = path.join(current, ".linear-agent", "trae-active-session.json");
    try {
      const context = JSON.parse(await fs.readFile(candidate, "utf8"));
      return { candidate, context };
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function cleanName(value) {
  return typeof value === "string"
    ? value.replace(/[^a-zA-Z0-9_.:/ -]/g, "").slice(0, 80)
    : "";
}

function summarize(payload) {
  const event = cleanName(payload.hook_event_name || payload.event || process.env.TRAE_HOOK_EVENT);
  const tool = cleanName(payload.tool_name || payload.toolName || payload.tool?.name);
  const input = payload.tool_input || payload.toolInput || payload.input || {};
  const file = cleanName(input.file_path || input.path || input.file || input.target_file);

  if (event === "SessionStart") return "Trae initialized locally and is analyzing the task.";
  if (event === "PreToolUse") {
    if (/edit|write|replace|patch/i.test(tool)) return file ? `Editing \`${file}\`` : "Editing project files";
    if (/read|view|search|grep|glob/i.test(tool)) return file ? `Inspecting \`${file}\`` : "Inspecting the codebase";
    if (/terminal|shell|bash|command/i.test(tool)) return "Running a development command";
    if (/test/i.test(tool)) return "Running project checks";
    return tool ? `Using ${tool}` : "Continuing implementation";
  }
  if (event === "PostToolUse") return tool ? `Finished ${tool}` : "Completed an implementation step";
  if (event === "Stop" || event === "SessionEnd") return "Trae finished its current work cycle.";
  return null;
}

async function main() {
  const payload = await readInput();
  const workspace = payload.cwd || payload.workspace_root || payload.workspaceRoot || process.cwd();
  const found = await findContext(workspace);
  const message = summarize(payload);
  if (!found || !message) return;
  const { context } = found;
  if (!context.token || !context.agentSessionId) return;

  const response = await fetch(context.activityEndpoint || "http://127.0.0.1:8788/trae-activity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: context.token,
      ...(context.jobKey ? { jobKey: context.jobKey } : {}),
      agentSessionId: context.agentSessionId,
      workspace: context.workspace,
      activityType: "thought",
      body: message,
    }),
  });
  if (!response.ok && response.status !== 202 && response.status !== 204) {
    throw new Error(`Local bridge rejected Trae activity (${response.status})`);
  }
}

main().catch((error) => {
  console.error(`Trae Linear progress hook: ${error.message}`);
  process.exit(1);
});
