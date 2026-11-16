import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { coordinateLocalExecution } from "../jobs/local-execution-coordinator.mjs";

const agents = ["mock", "antigravity", "chatgpt-cli", "chatgpt", "trae", "gemma", "gemini"];
const adapterName = {
  mock: "mock", antigravity: "antigravity", "chatgpt-cli": "chatgptCli",
  chatgpt: "chatgptHuman", trae: "trae", gemma: "gemma", gemini: "gemini",
};

function harness(agent, overrides = {}) {
  const events = [];
  const originalJob = { issueId: "ABR-28", payload: { data: { promptContext: "Test dispatch" } } };
  const routedJob = { issueId: "ABR-28", payload: { data: { promptContext: "Canonical prompt" } } };
  const route = { ok: true, projectScope: "repository", repositoryRoot: "/tmp/repo", scopeKey: "scope", launchDirectory: "/tmp/repo" };
  const dispatchers = Object.fromEntries(agents.map(name => [adapterName[name], async args => {
    events.push(["dispatch", name, args]);
  }]));
  const args = {
    job: originalJob, route, agent, jobKey: agent + ":delivery-1",
    safeJobId: "delivery-1", credential: { accessToken: "test-token" },
    host: "agent.example.test",
    jobStore: { transition: async (...params) => { events.push(["transition", ...params]); } },
    activeTaskMemory: {}, drainProgressWrites: async () => {},
    retrieveMemuMemory: async () => "",
    extractDirectTask: x => x, extractPromptContext: j => j.payload?.data?.promptContext,
    extractAgentSessionId: j => j.agentSessionId,
    agySessionQueue: {}, readAgyProjectConversation: async () => null,
    saveAgyProjectConversation: async () => {}, recordResumedConversation: async () => {},
    startAntigravity: () => {}, enqueueChatgptHandoff: () => {},
    startChatgptOpenCode: () => {}, projectDir: "/runtime/bridge",
    traeBin: "trae", traeArgsTemplate: "chat {{PROMPT}}",
    buildGenericArgs: () => [], maskArg: x => x, attachProcessLogs: () => {},
    startGemma: () => {}, geminiBin: "gemini", geminiLaunchMode: "headless",
    geminiArgsTemplate: "{{PROMPT}}", startGeminiInWarp: () => {},
    buildGeminiLaunch: () => ({}), spawnProcess: () => {},
    logger: { log: (...parts) => { events.push(["log", ...parts]); } },
    prepareTask: async params => {
      events.push(["prepare", params]);
      return { workspace: "/tmp/repo", filename: "/tmp/task.json", routedJob };
    },
    dispatchers,
    ...overrides,
  };
  return { args, events, routedJob, route, originalJob };
}

test("every agent dispatch preserves preparation, launching semantics, and response", async () => {
  for (const agent of agents) {
    const f = harness(agent);
    const result = await coordinateLocalExecution(f.args);
    assert.deepEqual(result, {
      status: 202, body: { ok: true, accepted: true, jobId: "delivery-1", host: "agent.example.test" },
    }, agent);
    const meaningful = f.events.filter(event => ["prepare", "transition", "dispatch"].includes(event[0]));
    assert.deepEqual(meaningful.map(event => event[0]),
      agent === "trae" ? ["prepare", "dispatch"] : ["prepare", "transition", "dispatch"], agent);
    if (agent !== "trae") assert.deepEqual(meaningful[1].slice(1),
      [agent + ":delivery-1", "launching", { attempts: 1 }]);
    assert.equal(meaningful.at(-1)[1], agent);
    assert.equal(meaningful.at(-1)[2].jobKey, agent + ":delivery-1");
    if (agent !== "mock") assert.equal(meaningful.at(-1)[2].job, f.routedJob);
    assert.equal(meaningful[0][1].job, f.originalJob);
    assert.equal(meaningful[0][1].jobStore, f.args.jobStore);
  }
});

test("local execution preserves provider-specific launch parameters and identity separation", async () => {
  for (const agent of agents) {
    const f = harness(agent);
    await coordinateLocalExecution(f.args);
    const detail = f.events.find(x => x[0] === "dispatch")[2];
    if (agent === "chatgpt") {
      assert.equal(detail.projectDir, "/runtime/bridge");
      assert.equal(detail.enqueueChatgptHandoff, f.args.enqueueChatgptHandoff);
      assert.equal(detail.extractPromptContext, f.args.extractPromptContext);
      assert.equal(detail.startChatgptOpenCode, undefined);
    } else if (agent === "chatgpt-cli") {
      assert.equal(detail.startChatgptOpenCode, f.args.startChatgptOpenCode);
      assert.equal(detail.enqueueChatgptHandoff, f.args.enqueueChatgptHandoff);
      assert.equal(detail.projectDir, undefined);
    } else if (agent === "antigravity") {
      assert.equal(detail.agySessionQueue, f.args.agySessionQueue);
      assert.equal(detail.startAntigravity, f.args.startAntigravity);
      assert.equal(detail.recordResumedConversation, f.args.recordResumedConversation);
    } else if (agent === "trae") {
      assert.equal(detail.repositoryRoot, f.route.repositoryRoot);
      assert.equal(detail.traeBin, "trae");
      assert.equal(detail.attachProcessLogs, f.args.attachProcessLogs);
    } else if (agent === "gemini") {
      assert.equal(detail.geminiBin, "gemini");
      assert.equal(detail.spawnProcess, f.args.spawnProcess);
      assert.equal(detail.buildGeminiLaunch, f.args.buildGeminiLaunch);
    } else if (agent === "gemma") {
      assert.equal(detail.startGemma, f.args.startGemma);
    } else if (agent === "mock") {
      assert.equal(detail.filename, "/tmp/task.json");
    }
  }
});

test("preparation failures never record launching or call an agent", async () => {
  const f = harness("gemini", { prepareTask: async () => { throw Error("task file unavailable"); } });
  await assert.rejects(coordinateLocalExecution(f.args), /task file unavailable/);
  assert.equal(f.events.some(x => ["transition", "dispatch"].includes(x[0])), false);
});

test("launching transition failure prevents non-Trae agents from dispatching", async () => {
  const f = harness("gemma");
  f.args.jobStore = { transition: async (...args) => {
    f.events.push(["transition", ...args]);
    throw Error("ledger not durable");
  } };
  await assert.rejects(coordinateLocalExecution(f.args), /ledger not durable/);
  assert.equal(f.events.some(x => x[0] === "dispatch"), false);
});

test("awaited launchers block the HTTP acknowledgment until completion or failure", async () => {
  for (const agent of ["mock", "chatgpt", "trae", "gemini"]) {
    const f = harness(agent);
    let finish;
    let started = false;
    const pending = new Promise(resolve => { finish = resolve; });
    f.args.dispatchers[adapterName[agent]] = () => { started = true; return pending; };
    let acknowledged = false;
    const result = coordinateLocalExecution(f.args).then(() => { acknowledged = true; });
    // Allow the asynchronous durable ledger and preparation steps to complete.
    for (let i = 0; i < 20 && !started; i++) await Promise.resolve();
    assert.equal(started, true, agent);
    assert.equal(acknowledged, false, agent);
    finish();
    await result;
    assert.equal(acknowledged, true, agent);
  }
});

test("queued launchers remain fire-and-forget after durable launching transition", async () => {
  for (const agent of ["antigravity", "chatgpt-cli", "gemma"]) {
    const f = harness(agent);
    let started = false;
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    f.args.dispatchers[adapterName[agent]] = () => { started = true; return pending; };
    const result = await coordinateLocalExecution(f.args);
    assert.equal(started, true, agent);
    assert.equal(result.status, 202);
    finish();
  }
});

test("unknown hostname preserves failed ledger state and original HTTP 202 contract", async () => {
  const f = harness("unknown");
  const result = await coordinateLocalExecution(f.args);
  assert.equal(result.status, 202);
  assert.deepEqual(f.events.filter(x => x[0] === "transition").map(x => x.slice(1)), [
    ["unknown:delivery-1", "launching", { attempts: 1 }],
    ["unknown:delivery-1", "failed", { error: "Unknown agent host" }],
  ]);
  assert.equal(f.events.some(x => x[0] === "dispatch"), false);
});

test("real local task persistence completes before execution and callback context stays scoped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-p4-local-execution-"));
  try {
    await fs.mkdir(path.join(root, ".git", "info"), { recursive: true });
    const route = { ok: true, repositoryRoot: root, launchDirectory: root,
      scopeKey: "scope-1", projectScope: "repository", projectId: "project-1" };
    const f = harness("mock", {
      route,
      activeTaskMemory: {
        read: async () => null,
        recoveryPreamble: () => "",
        update: async () => {},
      },
      retrieveMemuMemory: async () => "",
      extractDirectTask: value => value,
      prepareTask: undefined,
    });
    delete f.args.prepareTask; // use the production adapter's default
    f.args.dispatchers.mock = async ({ filename }) => {
      const content = JSON.parse(await fs.readFile(filename, "utf8"));
      assert.equal(content.payload.data.promptContext, "Test dispatch");
      f.events.push(["dispatch", "mock", { filename }]);
    };
    await coordinateLocalExecution(f.args);
    const transitions = f.events.filter(x => x[0] === "transition");
    assert.deepEqual(transitions.map(x => x[2]), ["queued", "launching"]);
    assert.equal(f.events.at(-1)[0], "dispatch");
    const saved = path.join(root, ".linear-agent", "projects", "scope-1", "inbox", "delivery-1.json");
    assert.equal((await fs.stat(saved)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bridge wires the coordinator after admission, keeps Mac execution and response ownership", async () => {
  const source = await fs.readFile(new URL("../bridge/server/agent-bridge-runtime.mjs", import.meta.url), "utf8");
  const auth = source.indexOf('if (request.headers.authorization !== `Bearer ${SHARED_SECRET}`)');
  const admission = source.indexOf("await coordinateJobAdmission({", auth);
  const remote = source.indexOf('if (route.executionHost === "macos")', admission);
  const local = source.indexOf("await coordinateLocalExecution({", remote);
  const response = source.indexOf("return sendJson(response, execution.status, execution.body)", local);
  assert.ok(auth >= 0 && auth < admission && admission < remote && remote < local && local < response);
  assert.match(source, /from "\.\.\/orchestration\/local-execution-coordinator\.mjs"/);
  assert.match(source, /const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(source, /server\.listen\(PORT, HOST,/);
});
