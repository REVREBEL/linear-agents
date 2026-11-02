#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function usage() {
  console.error("Usage: node scripts/chatgpt-shortcuts/handoff.mjs --handoff-file /absolute/path/to/handoff.json [--shortcut-name NAME] [--dry-run]");
  process.exit(2);
}

const args = process.argv.slice(2);
function value(flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

const handoffFile = value("--handoff-file");
const shortcutName = value("--shortcut-name") || process.env.CHATGPT_SHORTCUT_NAME || "Linear ChatGPT Handoff";
const dryRun = args.includes("--dry-run");

if (!handoffFile || !shortcutName || args.includes("--help")) usage();

const handoffPath = resolve(handoffFile);
const handoff = JSON.parse(await readFile(handoffPath, "utf8"));
const projectUrl = new URL(handoff.projectUrl || "https://invalid.local");

if (projectUrl.protocol !== "https:" || projectUrl.hostname !== "chatgpt.com" ||
    !/^\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(projectUrl.pathname)) {
  throw new Error("Shortcut handoff requires a validated existing ChatGPT Project conversation URL.");
}
if (handoff.conversationMode !== "reuse-existing") {
  throw new Error("Shortcut handoff requires conversationMode reuse-existing.");
}
if (typeof handoff.prompt !== "string" || !handoff.prompt.trim()) {
  throw new Error("Shortcut handoff requires a nonempty prompt.");
}
if (handoff.prompt.length > 8000) {
  throw new Error("Shortcut handoff prompt exceeds the 8,000 character safety limit.");
}

if (dryRun) {
  console.log(`Validated shortcut handoff for ${projectUrl.href}`);
  process.exit(0);
}

await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn("/usr/bin/shortcuts", ["run", shortcutName, "--input-path", handoffPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => process.stdout.write(chunk));
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  child.once("error", rejectPromise);
  child.once("close", code => code === 0
    ? resolvePromise()
    : rejectPromise(new Error(`Shortcut ${JSON.stringify(shortcutName)} exited with code ${code}`)));
});

console.log(`Shortcut ${JSON.stringify(shortcutName)} finished its handoff actions.`);
