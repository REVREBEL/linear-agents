import fs from "node:fs/promises";
import path from "node:path";

const VALID_EVENTS = new Set(["pull_request", "ping"]);
const VALID_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "closed", "converted_to_draft", "edited"]);
export function sanitizeGithubEvent(input) {
  if (!input || typeof input !== "object" || !VALID_EVENTS.has(input.event) ||
      typeof input.delivery !== "string" || !/^[a-zA-Z0-9-]{8,128}$/.test(input.delivery)) throw Error("Invalid GitHub event envelope");
  const p = input.payload;
  if (!p || typeof p !== "object") throw Error("Invalid GitHub event payload");
  if (input.event === "ping") return { event: "ping", delivery: input.delivery, action: "ping", repository: typeof p.repository?.full_name === "string" ? p.repository.full_name : null };
  if (!VALID_ACTIONS.has(p.action)) throw Error("Unsupported pull_request action");
  const pr = p.pull_request, repo = p.repository?.full_name;
  if (!pr || typeof repo !== "string" || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) ||
      !Number.isSafeInteger(pr.number) || pr.number <= 0 ||
      typeof pr.html_url !== "string" || pr.html_url !== `https://github.com/${repo}/pull/${pr.number}` ||
      typeof pr.head?.sha !== "string" || !/^[0-9a-f]{40}$/.test(pr.head.sha)) throw Error("Invalid pull request details");
  return { event: "pull_request", delivery: input.delivery, action: p.action,
    repository: repo, number: pr.number, url: pr.html_url, headSha: pr.head.sha,
    draft: pr.draft === true, installationId: Number.isSafeInteger(p.installation?.id) ? p.installation.id : null };
}
export async function recordGithubEvent(baseDir, event, source) {
  if (!/^(chatgpt|antigravity)$/.test(source)) throw Error("Invalid GitHub source agent");
  const directory = path.join(baseDir, "github-events");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const journal = path.join(directory, "events.jsonl");
  const record = { at: new Date().toISOString(), source, ...event };
  // Serialized by bridge request queue. Only allow known, sanitized fields.
  await fs.appendFile(journal, JSON.stringify(record) + "\n", { mode: 0o600 });
  return { journal, record };
}
