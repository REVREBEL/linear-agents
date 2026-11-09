import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, cp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const SECRET = "github-dispatch-test-only";
const SHA = "a".repeat(40);

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitForHealth(port, child, output) {
  const url = `http://127.0.0.1:${port}/health`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error(`Bridge exited: ${output()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(200) });
      if (response.ok && (await response.json()).service === "local-linear-agent-router") return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw Error(`Bridge did not become healthy: ${output()}`);
}
function pullRequestEnvelope(number, actorId, actorLogin) {
  return {
    event: "pull_request",
    delivery: `github-dispatch-${number}-test`,
    payload: {
      action: "opened",
      repository: { full_name: "REVREBEL/example" },
      sender: { id: actorId, login: actorLogin, type: "User" },
      pull_request: {
        number, html_url: `https://github.com/REVREBEL/example/pull/${number}`,
        head: { sha: SHA }, draft: false,
      },
      installation: { id: 123 },
    },
  };
}
async function sendEvent(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/github/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "x-github-agent": "chatgpt",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(4000),
  });
  const body = await response.text();
  assert.equal(response.status, 202, body);
  return JSON.parse(body);
}
async function runCase(identityEnv, assertions) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "github-self-origin-dispatch-"));
  const bridgeDir = path.join(temp, "linear-agent-bridge");
  const port = await findFreePort();
  let child;
  let stdout = "";
  let stderr = "";
  try {
    // Run an isolated copy of the real bridge implementation: no production ledger,
    // no GitHub credentials and no writes to the developer's working tree.
    await cp(sourceDir, bridgeDir, {
      recursive: true,
      filter: source => !source.includes(`${path.sep}.venv${path.sep}`) &&
        !source.includes(`${path.sep}linear-jobs${path.sep}`) &&
        !source.endsWith(`${path.sep}.env`),
    });
    const config = {
      version: 1,
      projects: {
        example: {
          repository: "REVREBEL/example",
          codeReview: {
            provider: "chatgpt",
            conversationMode: "reuse-existing",
            conversationUrl: "https://chatgpt.com/g/g-p-test/c/test-conversation",
            autoSend: true,
          },
        },
      },
    };
    const routingFile = path.join(temp, "routing.json");
    await writeFile(routingFile, JSON.stringify(config));
    const env = {
      ...process.env,
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: String(port),
      BRIDGE_SHARED_SECRET: SECRET,
      CHATGPT_HANDOFF_MODE: "shortcuts",
      ROUTING_CONFIG_FILE: routingFile,
      PROJECTS_ROOT: temp,
    };
    delete env.GITHUB_CHATGPT_SELF_IDS;
    delete env.GITHUB_CHATGPT_SELF_LOGINS;
    Object.assign(env, identityEnv);
    child = spawn(process.execPath, [path.join(bridgeDir, "agent-bridge.mjs")], {
      cwd: temp, env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    await waitForHealth(port, child, () => stdout + stderr);
    await assertions({
      port,
      async handoffCount() {
        const directory = path.join(bridgeDir, "linear-jobs", "github-events", "handoffs");
        return (await readdir(directory).catch(e => e.code === "ENOENT" ? [] : Promise.reject(e))).length;
      },
      async eventJournal() {
        const file = path.join(bridgeDir, "linear-jobs", "github-events", "events.jsonl");
        return (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      },
      async taskMemory() {
        const entries = await readdir(path.join(bridgeDir, "linear-jobs", "github-events"));
        return entries;
      },
    });
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        new Promise(resolve => setTimeout(resolve, 1500)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(temp, { recursive: true, force: true });
  }
}

test("GitHub dispatch honors explicitly configured self-origin identities, never implicit fallback", {
  skip: process.platform !== "linux" && "Linux CI integration test (avoids macOS Shortcuts)",
  timeout: 30000,
}, async () => {
  // The identity deliberately matches the previously hardcoded defaults.
  const own = pullRequestEnvelope(21, 352271105, "revrebel-chatgpt");
  await runCase({}, async ({port, handoffCount, eventJournal}) => {
    const result = await sendEvent(port, own);
    assert.equal(result.reviewDispatched, true, "unset env must preserve actionable review");
    assert.equal(await handoffCount(), 1, "real dispatcher must persist a handoff");
    assert.equal((await eventJournal()).length, 1);
  });
  await runCase({GITHUB_CHATGPT_SELF_IDS: "", GITHUB_CHATGPT_SELF_LOGINS: ""}, async ({port, handoffCount}) => {
    const result = await sendEvent(port, own);
    assert.equal(result.reviewDispatched, true, "empty env must preserve actionable review");
    assert.equal(await handoffCount(), 1);
  });
  await runCase({GITHUB_CHATGPT_SELF_IDS: "352271105", GITHUB_CHATGPT_SELF_LOGINS: "revrebel-chatgpt"}, async ({port, handoffCount, eventJournal}) => {
    const suppressed = await sendEvent(port, own);
    assert.equal(suppressed.reviewDispatched, false, "verified matching actor must be suppressed");
    assert.equal(await handoffCount(), 0, "self-authored event must not create a handoff");
    const unrelated = await sendEvent(port, pullRequestEnvelope(22, 3456, "outside-reviewer"));
    assert.equal(unrelated.reviewDispatched, true, "unrelated actor must still dispatch");
    assert.equal(await handoffCount(), 1);
    assert.equal((await eventJournal()).length, 2);
  });
});
