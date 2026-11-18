#!/usr/bin/env node
// Publish sanitized GitHub webhook event history without touching the developer's working tree.
// Run periodically from launchd only when desired. Uses existing git credentials.
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const journal = process.env.GITHUB_EVENT_JOURNAL || path.join(root, "linear-agent-bridge", "linear-jobs", "github-events", "events.jsonl");
function git(args, cwd, allowFailure = false) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  if (r.status !== 0 && !allowFailure) throw Error(`git ${args[0]} failed (exit ${r.status})`);
  return r;
}
const raw = await readFile(journal, "utf8").catch(error => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const lines = raw.split("\n").filter(Boolean);
if (!lines.length) {
  console.log("No GitHub events to publish.");
  process.exit(0);
}
const allowed = new Set(["at", "source", "event", "delivery", "action", "repository", "number", "url", "headSha", "draft", "installationId"]);
const events = lines.map(line => {
  const data = JSON.parse(line);
  if (!data || typeof data !== "object" || !/^[a-z0-9-]{8,128}$/i.test(data.delivery)) throw Error("Invalid event journal entry");
  return Object.fromEntries(Object.entries(data).filter(([key]) => allowed.has(key)));
});
const remote = process.env.GITHUB_EVENT_PUBLISH_REMOTE || git(["remote", "get-url", "origin"], root).stdout.trim();
const branch = process.env.GITHUB_EVENT_PUBLISH_BRANCH || "main";
if (!remote) throw Error("Missing publishing remote");
const temp = await mkdtemp(path.join(os.tmpdir(), "linearbridge-events-"));
try {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await rm(path.join(temp, "checkout"), { force: true, recursive: true });
    git(["clone", "--quiet", "--single-branch", "--branch", branch, "--depth", "1", remote, path.join(temp, "checkout")], temp);
    const checkout = path.join(temp, "checkout");
    const folder = path.join(checkout, "operations", "github-events");
    await mkdir(folder, { recursive: true });
    const byDate = new Map();
    for (const event of events) {
      const date = typeof event.at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(event.at) ? event.at.slice(0, 10) : "unknown-date";
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(event);
    }
    let added = 0;
    for (const [date, newEvents] of byDate) {
      const dest = path.join(folder, `${date}.jsonl`);
      const original = await readFile(dest, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
      const seen = new Set(original.split("\n").filter(Boolean).map(line => {
        const r = JSON.parse(line);
        return `${r.source}:${r.delivery}`;
      }));
      const append = newEvents.filter(event => {
        const key = `${event.source}:${event.delivery}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (append.length) {
        await writeFile(dest, original + (original && !original.endsWith("\n") ? "\n" : "") + append.map(x => JSON.stringify(x)).join("\n") + "\n");
        added += append.length;
      }
    }
    if (!added) { console.log("GitHub event history is already current."); break; }
    git(["add", "--", "operations/github-events"], checkout);
    git(["-c", "user.name=LinearBridge Events", "-c", "user.email=linearbridge-events@users.noreply.github.com", "commit", "-m", `chore(events): archive ${added} GitHub webhook deliveries`], checkout);
    if (git(["push", "origin", `HEAD:${branch}`], checkout, true).status === 0) {
      console.log(`Published ${added} GitHub event(s) to ${branch}.`);
      break;
    }
    if (attempt === 3) throw Error("Event publishing push failed after three attempts");
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
