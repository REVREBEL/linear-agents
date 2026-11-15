import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHttpRouteComposer } from "../bridge/server/http-route-composition.mjs";

async function withComposer(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-http-composition-"));
  const trace = [];
  const response = {
    status: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
  };
  const deps = {
    jobsDir: dir,
    env: { CHATGPT_HANDOFF_CALLBACK_TOKEN: "secret-token" },
    readBody: async request => request.body,
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
    logger: { log: message => trace.push(["log", message]) },
    handleDiagnosticRoute: () => { trace.push("diagnostic"); return false; },
    handleReviewRoute: async () => { trace.push("review"); return false; },
    handleGithubWebhookRoute: async () => { trace.push("github"); return false; },
    handleTraeCallbackRoute: async () => { trace.push("trae"); return false; },
    handleIssueCompletionRoute: async () => { trace.push("issue"); return false; },
  };
  const run = async (pathname, method = "GET", headers = {}, body = "") => {
    response.status = null; response.body = null; response.headers = {};
    trace.length = 0;
    const url = new URL(pathname, "http://agent.test");
    const request = { method, headers, body };
    const handled = await createHttpRouteComposer(deps)(request, response, { url, host: "agent.test" });
    return { handled, status: response.status, body: response.body, headers: response.headers, trace: [...trace] };
  };
  try { await callback({ dir, trace, response, deps, run }); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test("routing falls through in original order and leaves /jobs to the bridge", async () => {
  await withComposer(async ({ run }) => {
    const result = await run("/jobs", "POST", { authorization: "Bearer jobs-secret" });
    assert.equal(result.handled, false);
    assert.equal(result.status, null);
    assert.deepEqual(result.trace, ["diagnostic", "review", "github", "trae", "issue"]);
  });
});

test("each route short circuits subsequent handlers", async () => {
  for (const [target, expected] of [
    ["diagnostic", ["diagnostic"]],
    ["review", ["diagnostic", "review"]],
    ["github", ["diagnostic", "review", "github"]],
    ["trae", ["diagnostic", "review", "github", "trae"]],
    ["issue", ["diagnostic", "review", "github", "trae", "issue"]],
  ]) {
    await withComposer(async ({ deps, run, trace }) => {
      const key = {
        diagnostic: "handleDiagnosticRoute", review: "handleReviewRoute",
        github: "handleGithubWebhookRoute", trae: "handleTraeCallbackRoute",
        issue: "handleIssueCompletionRoute",
      }[target];
      deps[key] = async () => { trace.push(target); return true; };
      const result = await run("/arbitrary", "GET");
      assert.equal(result.handled, true);
      assert.deepEqual(result.trace, expected);
    });
  }
});

test("legacy shortcut GET records valid handoff result before the other routes", async () => {
  await withComposer(async ({ dir, run }) => {
    const id = "valid-handoff-id-42";
    const result = await run(`/github/handoff-result&handoffid=${id}?success`);
    assert.equal(result.handled, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, status: "success", handoffId: id });
    assert.equal(result.trace[0], "diagnostic");
    assert.equal(result.trace.includes("review"), false);
    const data = await fs.readFile(path.join(dir, "chatgpt", "handoff-results", "results.jsonl"), "utf8");
    const entry = JSON.parse(data.trim());
    assert.equal(entry.source, "shortcuts");
    assert.equal(entry.stage, "handoff");
    assert.equal(entry.status, "success");
    assert.equal(entry.handoffId, id);
    assert.equal((await fs.stat(path.join(dir, "chatgpt", "handoff-results", "results.jsonl"))).mode & 0o777, 0o600);
  });
});

test("shortcut GET rejects missing, duplicate, or invalid outcome flags", async () => {
  await withComposer(async ({ run, dir }) => {
    for (const url of [
      "/github/handoff-result",
      "/github/handoff-result?success&error",
      "/github/handoff-result?success&handoffid=invalid",
    ]) {
      const result = await run(url);
      assert.equal(result.handled, true);
      assert.equal(result.status, 400, url);
      assert.equal(result.trace.includes("review"), false);
    }
    await assert.rejects(fs.stat(path.join(dir, "chatgpt", "handoff-results", "results.jsonl")), { code: "ENOENT" });
  });
});

test("shortcut POST requires configured bearer token with strict byte equality", async () => {
  await withComposer(async ({ deps, run }) => {
    const payload = JSON.stringify({ handoffId: "valid-handoff-id-42", status: "success", stage: "done" });
    deps.env = {};
    assert.equal((await run("/github/handoff-result", "POST", {}, payload)).status, 503);
    deps.env = { CHATGPT_HANDOFF_CALLBACK_TOKEN: "secret-token" };
    for (const header of [undefined, "Bearer wrong", "Bearer secret-token-extra"]) {
      const response = await run("/github/handoff-result", "POST",
        header ? { authorization: header } : {}, payload);
      assert.equal(response.status, 401);
    }
    const response = await run("/github/handoff-result", "POST",
      { authorization: "Bearer secret-token" }, payload);
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, {
      ok: true, accepted: true, handoffId: "valid-handoff-id-42", status: "success",
    });
  });
});

test("shortcut POST enforces method, payload shape and original error redaction", async () => {
  await withComposer(async ({ run, dir }) => {
    const auth = { authorization: "Bearer secret-token" };
    const method = await run("/github/handoff-result", "PUT", auth);
    assert.equal(method.status, 405);
    assert.equal(method.headers.Allow, "POST");
    assert.equal((await run("/github/handoff-result", "POST", auth, "{")).status, 400);
    assert.equal((await run("/github/handoff-result", "POST", auth, "null")).status, 400);
    assert.equal((await run("/github/handoff-result", "POST", auth,
      JSON.stringify({ handoffId: "valid-handoff-id-42", status: "success", stage: "x", error: 7 }))).status, 400);
    const response = await run("/github/handoff-result", "POST", auth,
      JSON.stringify({ handoffId: "valid-handoff-id-42", status: "error", stage: "verification", error: "failed" }));
    assert.equal(response.status, 202);
    const rows = (await fs.readFile(path.join(dir, "chatgpt", "handoff-results", "results.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].error, "failed");
    assert.equal(rows[0].stage, "verification");
  });
});

test("bridge owns HTTP listener, final 404, and /jobs authorization after composed routes", async () => {
  const source = await fs.readFile(new URL("../bridge/server/agent-bridge-runtime.mjs", import.meta.url), "utf8");
  const compose = source.indexOf("await handleComposedRoutes(request, response, { host, url })");
  const notFound = source.indexOf('if (request.method !== "POST" || url.pathname !== "/jobs")', compose);
  const auth = source.indexOf('if (request.headers.authorization !== `Bearer ${SHARED_SECRET}`)', notFound);
  const admission = source.indexOf("await coordinateJobAdmission({", auth);
  assert.ok(compose >= 0 && compose < notFound && notFound < auth && auth < admission);
  assert.match(source, /const server = http\.createServer\(async \(request, response\) => \{/);
  assert.match(source, /server\.listen\(PORT, HOST,/);
});
