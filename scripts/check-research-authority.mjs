#!/usr/bin/env node
// ABR-78: reject research/context data imports from executable Bridge paths.
// Static guardrail: active admission and dispatch must never accept a catalog,
// promotion proposal, README bundle, or staged host manifest as authority.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTABLE_ROOTS = [
  "bridge/", "jobs/", "routing/", "linear-agent-bridge/",
  "agents/coding/", "agents/bridge/", "integrations/",
  "linear-antigravity-worker/", "linear-chatgpt-worker/",
  "linear-gemini-worker/", "linear-trae-worker/", "linear-mock-worker/",
];
const ADDITIONAL_SOURCES = [
  "scripts/agent-worker-registry.mjs",
  "scripts/validate-agent-registry.mjs",
];
const SOURCE_SUFFIX = /\.(?:mjs|cjs|js|ts|tsx|py)$/i;
const EXCLUDED = /(?:^|\/)(?:__tests__\/|test\/|tests\/)|(?:\.test|\.spec)\.(?:mjs|cjs|js|ts|tsx|py)$/i;
const DENIED = [
  ["research catalog", /agents\/agent-registry(?:-v2)?\.ya?ml/i],
  ["research candidate profile", /agents\/profiles\/(?:candidates|research)\//i],
  ["research proposal compiler", /review-research-promotion\.py/i],
  ["research proposal payload", /reviewed-proposal-not-installed|researchSha256/i],
  ["README context bundle", /(?:\.agents\/context\.yaml|\.managed-context\.json|templates\/context\/)/i],
  ["host staged registry", /agent-runtimes\.staged\.json/i],
];

const fail = message => { throw new Error("Research authority boundary: " + message); };
const allowed = name => (EXECUTABLE_ROOTS.some(prefix => name.startsWith(prefix))
  || ADDITIONAL_SOURCES.includes(name))
  && SOURCE_SUFFIX.test(name) && !EXCLUDED.test(name);

export function trackedExecutableSources(root = REPO_ROOT) {
  const paths = execFileSync("git", ["-C", root, "ls-files", "-z", "--",
    ...EXECUTABLE_ROOTS, ...ADDITIONAL_SOURCES], { encoding: "utf8" })
    .split("\0").filter(allowed).sort();
  for (const required of [
    "bridge/server/agent-bridge-runtime.mjs",
    "jobs/admission/job-preflight.mjs",
    "jobs/admission/job-admission.mjs",
    "scripts/agent-worker-registry.mjs",
    "scripts/validate-agent-registry.mjs",
  ]) if (!paths.includes(required)) fail("Missing required executable audit target: " + required);
  return paths;
}

export function auditResearchAuthority(root = REPO_ROOT, filePaths = trackedExecutableSources(root)) {
  if (filePaths.length === 0) fail("No executable sources selected");
  const hits = [];
  for (const name of filePaths) {
    if (!allowed(name) || path.isAbsolute(name) || name.split("/").includes(".."))
      fail("Unsafe audit path: " + name);
    const source = readFileSync(path.join(root, name), "utf8");
    for (const [label, pattern] of DENIED) {
      if (pattern.test(source)) hits.push(name + " imports/references " + label);
    }
  }
  if (hits.length) fail(hits.join("; "));
  return filePaths.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log("Checked " + auditResearchAuthority()
      + " executable Bridge sources: no direct research/context authority references.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
