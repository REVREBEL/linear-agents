import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import net from "node:net";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
test("Ubuntu accepts actionable PR into separate ChatGPT user inbox with authenticated claim", { timeout: 30000 }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "linear-review-inbox-api-"));
  const dir = path.join(tmp, "linear-agent-bridge");
  const bridgePort = await port();
  const secret = "bridge-shared-test-only";
  const reviewToken = "review-user-test-token-with-more-than-32-characters";
  let child;
  let output = "";
  try {
    await cp(sourceDir, dir, { recursive: true, filter: name =>
      !name.includes(path.sep + "linear-jobs" + path.sep) &&
      !name.endsWith(path.sep + ".env") && !name.includes(path.sep + ".venv" + path.sep)
    });
    // The bridge now imports stateless domain modules from repository-root folders.
    // Mirror those modules into this isolated fixture without copying live state.
    for (const folder of ["routing", "jobs", "conversations"]) {
      await cp(path.join(sourceDir, "..", folder), path.join(tmp, folder), { recursive: true });
    }
    const routingFile = path.join(tmp, "routing.json");
    await writeFile(routingFile, JSON.stringify({ projects: {
      project: { repository: "REVREBEL/linear-agents", codeReview: {
        provider: "chatgpt", autoSend: true, conversationMode: "reuse-existing",
        conversationUrl: "https://chatgpt.com/g/g-p-test/c/review-session",
      } },
    }}));
    child = spawn(process.execPath, [path.join(dir, "agent-bridge.mjs")], {
      cwd: tmp,
      env: {
        ...process.env, BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: String(bridgePort),
        BRIDGE_SHARED_SECRET: secret, ROUTING_CONFIG_FILE: routingFile,
        CHATGPT_REVIEW_MODE: "inbox", CHATGPT_REVIEW_INBOX_TOKEN: reviewToken,
        CHATGPT_REVIEW_NOTIFY_MODE: "", PROJECTS_ROOT: tmp,
        GITHUB_CHATGPT_SELF_IDS: "", GITHUB_CHATGPT_SELF_LOGINS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const base = "http://127.0.0.1:" + bridgePort;
    let healthy = false;
    for (let n = 0; n < 100; n++) {
      if (child.exitCode !== null) throw Error("Bridge failed: " + output.slice(-1500));
      try {
        const r = await fetch(base + "/health", { signal: AbortSignal.timeout(200) });
        if (r.ok) { healthy = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(healthy, true, "Bridge health timed out: " + output.slice(-1500));
    const headers = { authorization: "Bearer " + reviewToken, "content-type": "application/json" };
    const unauthorized = await fetch(base + "/reviews/pending");
    assert.equal(unauthorized.status, 401);
    const event = { event: "pull_request", delivery: "review-inbox-001-2026",
      payload: { action: "ready_for_review", repository: { full_name: "REVREBEL/linear-agents" },
        pull_request: { number: 51,
          html_url: "https://github.com/REVREBEL/linear-agents/pull/51",
          head: { sha: "b".repeat(40) }, draft: false,
        },
      },
    };
    const dispatched = await fetch(base + "/github/events", { method: "POST",
      headers: { authorization: "Bearer " + secret, "x-github-agent": "chatgpt",
        "content-type": "application/json" }, body: JSON.stringify(event) });
    const accepted = await dispatched.json();
    assert.equal(dispatched.status, 202, JSON.stringify(accepted));
    assert.equal(accepted.reviewQueued, true);
    assert.equal(accepted.reviewDispatched, false);
    assert.equal(accepted.reviewNotified, false);
    const pending = await (await fetch(base + "/reviews/pending", { headers })).json();
    assert.equal(pending.reviews.length, 1);
    assert.equal(pending.reviews[0].role, "chatgpt-user-review");
    const reviewId = pending.reviews[0].reviewId;
    const claimed = await fetch(base + "/reviews/claim", {
      method: "POST", headers,
      body: JSON.stringify({ reviewId, reviewer: "chatgpt-user" }),
    });
    assert.equal(claimed.status, 200);
    const finish = await fetch(base + "/reviews/complete", {
      method: "POST", headers,
      body: JSON.stringify({ reviewId, status: "blocked", summary: "CI failure needs a fix" }),
    });
    assert.equal(finish.status, 200);
    const none = await (await fetch(base + "/reviews/pending", { headers })).json();
    assert.equal(none.reviews.length, 0);
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
