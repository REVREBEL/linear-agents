#!/usr/bin/env node
// Interactive Mock Agent submission through the Mock Worker's app OAuth token.
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const args = process.argv.slice(2);
const opt = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const jobPath = opt("--job");
const job = jobPath ? JSON.parse(await fs.readFile(path.resolve(jobPath), "utf8")) : null;
const issue = opt("--issue") || job?.issueMetadata?.id;
const organizationId = opt("--organization") || job?.organizationId || process.env.LINEAR_ORGANIZATION_ID;
const secret = process.env.BRIDGE_SHARED_SECRET;
const endpoint = process.env.MOCK_AGENT_URL || "https://linear-mock.revrebel.io/mock-action";
if (!issue || !organizationId || !secret) {
  console.error("Required: --job PATH (or --issue REV-123 --organization ORG_ID), plus BRIDGE_SHARED_SECRET environment variable.");
  process.exit(2);
}
async function call(operation, extras = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type":"application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ operation, issue, organizationId, ...extras }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(JSON.stringify(body));
  return body;
}
const data = await call("inspect");
console.log(`\n${data.issue.identifier}: ${data.issue.title}\nCurrent status: ${data.issue.status}\n`);
const rl = createInterface({ input: stdin, output: stdout });
try {
  console.log("Enter your comment (end with a line containing only a period; leave blank to skip):");
  const lines = [];
  while (true) {
    const line = await rl.question(lines.length ? "" : "> ");
    if (line === ".") break;
    if (!line && lines.length === 0) break;
    lines.push(line);
  }
  const comment = lines.join("\n").trim();
  console.log("\nSelect a status:");
  console.log("0) Keep current status");
  data.statuses.forEach((s,i) => console.log(`${i+1}) ${s.name} [${s.type}]`));
  const selected = (await rl.question("Status number: ")).trim() || "0";
  if (!/^\d+$/.test(selected) || Number(selected) > data.statuses.length) throw new Error("Invalid selection");
  const status = Number(selected) === 0 ? null : data.statuses[Number(selected)-1];
  if (!comment && !status) { console.log("Nothing to submit."); process.exitCode = 0; }
  else {
    console.log(`\nComment: ${comment || "(none)"}\nNew status: ${status?.name || "(unchanged)"}`);
    const confirm = await rl.question('Type YES to submit as Mock Agent: ');
    if (confirm !== "YES") console.log("Cancelled. No changes made.");
    else {
      const result = await call("submit", { comment, statusId: status?.id });
      console.log(`Submitted as the Mock app: comment=${result.commentPosted}, statusChanged=${result.statusChanged}`);
    }
  }
} finally { rl.close(); }
