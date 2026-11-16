import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Canonical source inventory for ABR-28 P5.2.
 * All former paths stay as import-identity preserving compatibility shims.
 */
export const canonicalModules = Object.freeze({
  "bridge/http-route-composition.mjs": "bridge/server/http-route-composition.mjs",
  "bridge/http-helpers.mjs": "bridge/server/http-helpers.mjs",
  "bridge/diagnostic-routes.mjs": "bridge/handlers/diagnostic-routes.mjs",
  "bridge/review-routes.mjs": "bridge/handlers/review-routes.mjs",
  "bridge/trae-callback-routes.mjs": "bridge/handlers/trae-callback-routes.mjs",
  "bridge/github-webhook-routes.mjs": "bridge/handlers/github-webhook-routes.mjs",
  "bridge/issue-completion-route.mjs": "bridge/handlers/issue-completion-route.mjs",
  "bridge/agent-host-resolver.mjs": "bridge/config/agent-host-resolver.mjs",
  "bridge/review-inbox.mjs": "bridge/orchestration/review-inbox.mjs",
  "bridge/review-delivery.mjs": "bridge/orchestration/review-delivery.mjs",
  "bridge/review-message-handoff.mjs": "bridge/orchestration/review-message-handoff.mjs",
  "bridge/prompt-arguments.mjs": "bridge/orchestration/prompt-arguments.mjs",
  "jobs/job-admission-coordinator.mjs": "bridge/orchestration/job-admission-coordinator.mjs",
  "jobs/local-execution-coordinator.mjs": "bridge/orchestration/local-execution-coordinator.mjs",
  "jobs/remote-execution-coordinator.mjs": "bridge/orchestration/remote-execution-coordinator.mjs",
  "jobs/job-admission.mjs": "jobs/admission/job-admission.mjs",
  "jobs/job-preflight.mjs": "jobs/admission/job-preflight.mjs",
  "jobs/unrouted-delivery.mjs": "jobs/admission/unrouted-delivery.mjs",
  "jobs/antigravity-dispatch.mjs": "jobs/dispatch/antigravity-dispatch.mjs",
  "jobs/chatgpt-cli-dispatch.mjs": "jobs/dispatch/chatgpt-cli-dispatch.mjs",
  "jobs/chatgpt-human-handoff.mjs": "jobs/dispatch/chatgpt-human-handoff.mjs",
  "jobs/gemini-dispatch.mjs": "jobs/dispatch/gemini-dispatch.mjs",
  "jobs/simple-agent-dispatch.mjs": "jobs/dispatch/simple-agent-dispatch.mjs",
  "jobs/trae-local-dispatch.mjs": "jobs/dispatch/trae-local-dispatch.mjs",
  "jobs/local-task-preparation.mjs": "jobs/preparation/local-task-preparation.mjs",
  "jobs/job-store.mjs": "jobs/persistence/job-store.mjs",
  "jobs/ordered-progress.mjs": "jobs/lifecycle/ordered-progress.mjs",
  "jobs/process-lifecycle.mjs": "jobs/lifecycle/process-lifecycle.mjs",
  "routing/host-routing.mjs": "routing/hosts/host-routing.mjs",
  "routing/ssh-dispatch.mjs": "routing/ssh/ssh-dispatch.mjs",
  "routing/remote-trae-activity.mjs": "routing/ssh/remote-trae-activity.mjs",
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("P5.2: every canonical module has a real source body, old paths are import-only shims", async () => {
  for (const [oldPath, newPath] of Object.entries(canonicalModules)) {
    const oldSource = await fs.readFile(path.join(root, oldPath), "utf8");
    const newSource = await fs.readFile(path.join(root, newPath), "utf8");
    assert.match(oldSource, /^export (?:\*|\{[^}]+\}) from "[^"]+";\n?$/, oldPath);
    assert.ok(newSource.length > 100, `Empty canonical implementation: ${newPath}`);
    assert.notEqual(oldSource, newSource, `Duplicate canonical implementation: ${oldPath}`);
  }
});

test("P5.2: all compatibility paths resolve to exactly the same exports as canonical code", async () => {
  for (const [oldPath, newPath] of Object.entries(canonicalModules)) {
    const legacy = await import(pathToFileURL(path.join(root, oldPath)).href);
    const canonical = await import(pathToFileURL(path.join(root, newPath)).href);
    assert.deepEqual(Object.keys(legacy).sort(), Object.keys(canonical).sort(), oldPath);
    for (const [name, value] of Object.entries(canonical)) {
      assert.strictEqual(legacy[name], value, `${oldPath} export ${name}`);
    }
  }
});

test("P5.2: production entrypoint imports canonical code and retains live job root", async () => {
  const bridge = await fs.readFile(path.join(root, "bridge/server/agent-bridge-runtime.mjs"), "utf8");
  const required = Object.values(canonicalModules).filter(p => (
    p.startsWith("bridge/") || p.startsWith("jobs/") || p.startsWith("routing/")
  ));
  const runtimeDeps = [
    "bridge/server/http-route-composition.mjs",
    "bridge/server/http-helpers.mjs",
    "bridge/handlers/diagnostic-routes.mjs",
    "bridge/handlers/trae-callback-routes.mjs",
    "bridge/handlers/github-webhook-routes.mjs",
    "bridge/handlers/review-routes.mjs",
    "bridge/handlers/issue-completion-route.mjs",
    "bridge/config/agent-host-resolver.mjs",
    "bridge/orchestration/review-inbox.mjs",
    "bridge/orchestration/review-delivery.mjs",
    "bridge/orchestration/review-message-handoff.mjs",
    "bridge/orchestration/prompt-arguments.mjs",
    "bridge/orchestration/job-admission-coordinator.mjs",
    "bridge/orchestration/local-execution-coordinator.mjs",
    "bridge/orchestration/remote-execution-coordinator.mjs",
    "jobs/lifecycle/ordered-progress.mjs",
    "jobs/lifecycle/process-lifecycle.mjs",
    "jobs/persistence/job-store.mjs",
    "routing/hosts/host-routing.mjs",
    "routing/ssh/ssh-dispatch.mjs",
  ];
  for (const target of runtimeDeps) {
    assert.ok(required.includes(target), `Missing ownership inventory item ${target}`);
    const relativeImport = path.relative(path.join(root, "bridge/server"), path.join(root, target));
    const specifier = relativeImport.startsWith(".") ? relativeImport : "./" + relativeImport;
    assert.ok(bridge.includes(`from "${specifier}"`), `Bridge still imports legacy module: ${target}`);
  }
  assert.ok(bridge.includes('const JOBS_DIR = path.join(PROJECT_DIR, "linear-jobs")'));
  assert.ok(bridge.includes('const server = http.createServer(async (request, response) => {'));
  assert.ok(bridge.includes('server.listen(PORT, HOST,'));
});

test("P5.2: legacy bridge entrypoint is an import-only loader for canonical server runtime", async () => {
  const loader = await fs.readFile(path.join(root, "linear-agent-bridge/agent-bridge.mjs"), "utf8");
  const runtime = await fs.readFile(path.join(root, "bridge/server/agent-bridge-runtime.mjs"), "utf8");
  assert.match(loader, /^\/\/[^\n]*\nimport "\.\.\/bridge\/server\/agent-bridge-runtime\.mjs";\n$/);
  assert.equal(loader.includes("server.listen("), false);
  assert.ok(runtime.includes('new URL("../../linear-agent-bridge/agent-bridge.mjs", import.meta.url)'));
  assert.ok(runtime.includes('const JOBS_DIR = path.join(PROJECT_DIR, "linear-jobs")'));
});
