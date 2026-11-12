#!/usr/bin/env node
// Explicit terminal callback for a Mac Trae agent. Do not invoke from Stop:
// a UI Stop event is not proof that the Linear task is finished.
import fs from "node:fs/promises";
import path from "node:path";

export async function findTraeContext(start = process.cwd(), fsApi = fs) {
  let folder = path.resolve(start);
  for (;;) {
    try {
      return JSON.parse(await fsApi.readFile(path.join(folder, ".linear-agent", "trae-active-session.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(folder);
    if (parent === folder) throw Error("No Trae active-session context in workspace ancestors");
    folder = parent;
  }
}

export async function sendTraeCompletion({ status, body, workspace = process.cwd(), readContext = findTraeContext, fetchImpl = fetch }) {
  if (!["completed", "failed"].includes(status) || typeof body !== "string" || !body.trim() || body.length > 4000) {
    throw Error("Usage: node complete.mjs <completed|failed> <brief result>");
  }
  const context = await readContext(workspace);
  if (!context.completionEndpoint || !context.token || !context.jobKey || !context.agentSessionId) {
    throw Error("Incomplete Trae completion context");
  }
  const response = await fetchImpl(context.completionEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jobKey: context.jobKey, token: context.token,
      agentSessionId: context.agentSessionId, workspace: context.workspace,
      status, body: body.trim(),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("Ubuntu bridge did not confirm completion (HTTP " + response.status + ")");
  return response.json();
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (direct) {
  sendTraeCompletion({ status: process.argv[2], body: process.argv.slice(3).join(" ") })
    .then(() => console.log("Trae completion confirmed by Ubuntu bridge"))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
