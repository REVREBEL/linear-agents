#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const args = process.argv.slice(2);
const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const jobPath = option("--job");
if (!jobPath) {
  console.error('Usage: npm run mock:end -- --job "/absolute/path/to/inbox/job.json"');
  process.exit(2);
}
const file = path.resolve(jobPath);
const job = JSON.parse(await fs.readFile(file, "utf8"));
const sessionId = job.agentSessionId || job.payload?.data?.agentSessionId;
const completionUrl = job.completionUrl || job.payload?.data?.completionUrl;
const organizationId = job.organizationId;
const secret = process.env.BRIDGE_SHARED_SECRET;
const missing = [];
if (!sessionId) missing.push("agentSessionId in job JSON");
if (!completionUrl) missing.push("completionUrl in job JSON");
if (!secret) missing.push("BRIDGE_SHARED_SECRET in the loaded environment");
if (missing.length) {
  console.error("Cannot end Mock Agent session. Missing:\n- " + missing.join("\n- "));
  process.exit(2);
}
const endpoint = new URL(completionUrl);
if (endpoint.protocol !== "https:" || endpoint.hostname !== "linear-mock.revrebel.io" || endpoint.pathname !== "/complete" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  throw new Error("Unexpected completion endpoint in job. Refusing to send credentials.");
}
const prompt = job.payload?.data?.promptContext || "";
const issue = job.issueMetadata?.identifier ||
  prompt.match(/^Issue:\s*([A-Z]+-\d+)/m)?.[1] ||
  prompt.match(/<issue\b[^>]*identifier="([A-Z]+-\d+)"/)?.[1] ||
  "(unknown issue)";
const rl = createInterface({ input: stdin, output: stdout });
try {
  console.log("\nMock Agent session:", sessionId);
  console.log("Issue:", issue);
  console.log("Job:", file);
  console.log("\n1) Completed (ends agent session; keeps inbox until issue is Done)");
  console.log("2) Failed (retains inbox for investigation)");
  console.log("0) Cancel");
  const selection = (await rl.question("End session as [1/2/0]: ")).trim();
  if (selection === "0" || !selection) console.log("Cancelled.");
  else if (selection !== "1" && selection !== "2") throw new Error("Invalid selection; nothing submitted.");
  else {
    const status = selection === "1" ? "completed" : "failed";
    const notes = (await rl.question("Optional final session note (Enter to skip): ")).trim();
    console.log("\nSession outcome:", status);
    if (notes) console.log("Note:", notes);
    console.log("Inbox: retained until the Linear issue is completed");
    const confirmation = await rl.question("Type YES to notify Linear and end this session: ");
    if (confirmation !== "YES") console.log("Cancelled. No changes submitted.");
    else {
      const response = await fetch(endpoint.toString(), {
        method: "POST",
        headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
        body: JSON.stringify({
          agentSessionId: sessionId,
          ...(organizationId ? { organizationId } : {}),
          status,
          ...(notes ? { body: notes } : {}),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error("Completion rejected (HTTP " + response.status + "): " + JSON.stringify(result));
      console.log("Linear session reported as " + status + ".");
      if (status === "completed") console.log("Inbox is retained until the Linear issue is moved to a completed status.");
    }
  }
} finally { rl.close(); }
