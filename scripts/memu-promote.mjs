#!/usr/bin/env node
/**
 * Prepare a *verified, faithfully captured* completed session for memU.
 * memU requires a separate executor between prepare and commit. We do not
 * invent chat messages from an issue summary or mark a task complete here.
 *
 * Usage:
 * node scripts/memu-promote.mjs <session.json> <verification.json>
 *
 * The CLI prints memU's executor_prompt and next_command as JSON. A trusted
 * executor must process ALL jobs serially before running commit.
 */
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

export function validatePromotion(session, evidence) {
  if (!session || session.schema_version !== "1.0" ||
      !Array.isArray(session.items) || !session.items.some(x =>
        x?.type === "message" && ["user", "assistant"].includes(x.role) &&
        typeof x.content === "string" && x.content.length > 0)) {
    throw Error("A genuine canonical memU session with at least one message is required");
  }
  if (session.items.some(x => !x || !["message", "tool_call", "tool_result"].includes(x.type)))
    throw Error("Invalid canonical session item");
  if (!evidence || evidence.review?.status !== "approved" ||
      evidence.tests?.status !== "passed" ||
      !/^[0-9a-f]{40}$/.test(evidence.review?.headSha || "") ||
      evidence.review.headSha !== evidence.tests.headSha ||
      typeof evidence.issueId !== "string" || !evidence.issueId) {
    throw Error("Verified review and passing tests for the same PR head are required");
  }
  return { issueId: evidence.issueId, headSha: evidence.review.headSha };
}

export async function prepareMemuPromotion(sessionPath, evidencePath, binary = "memu") {
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  validatePromotion(session, evidence);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["memorize", "prepare", sessionPath, "--json"], {
      shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", part => { stdout += part; if (stdout.length > 1024 * 1024) child.kill(); });
    child.stderr.on("data", part => { stderr += part; if (stderr.length > 4096) stderr = stderr.slice(-4096); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(Error("memU prepare failed: " + stderr.slice(-250)));
      try {
        const result = JSON.parse(stdout);
        if (!Array.isArray(result.jobs) || !result.executor_prompt || !result.next_command)
          throw Error("Invalid memU prepare response");
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const [sessionPath, evidencePath] = process.argv.slice(2);
  if (!sessionPath || !evidencePath) {
    console.error("Usage: node scripts/memu-promote.mjs <canonical-session.json> <verification.json>");
    process.exitCode = 2;
  } else {
    prepareMemuPromotion(sessionPath, evidencePath, process.env.MEMU_BIN || "memu")
      .then(value => process.stdout.write(JSON.stringify(value, null, 2) + "\n"))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
