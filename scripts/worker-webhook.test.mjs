import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperSource = await fs.readFile(path.join(root, "shared/oauth-errors.ts"), "utf8");
const transpile = source => stripTypeScriptTypes(source, { mode: "strip" });
const dataUrl = source => "data:text/javascript;base64," + Buffer.from(transpile(source)).toString("base64");
const helperUrl = dataUrl(helperSource);
const deliveryUrl = dataUrl(await fs.readFile(path.join(root, "shared/delivery-coordinator.ts"), "utf8"));
const installationSource = (await fs.readFile(path.join(root, "shared/oauth-installation.ts"), "utf8"))
  .replaceAll('"./oauth-errors"', JSON.stringify(helperUrl));
const installationUrl = dataUrl(installationSource);
const bridgeTokenSource = (await fs.readFile(path.join(root, "shared/bridge-access-token.ts"), "utf8"))
  .replaceAll('"./oauth-installation"', JSON.stringify(installationUrl));
const bridgeTokenUrl = dataUrl(bridgeTokenSource);
const githubHomeUrl = dataUrl(await fs.readFile(path.join(root, "shared/github-app-homepage.ts"), "utf8"));
const agentLocationUrl = dataUrl(await fs.readFile(path.join(root, "shared/agent-location.ts"), "utf8"));
const cloudflareStubUrl = "data:text/javascript;base64," + Buffer.from(
  "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
).toString("base64");

async function loadWorker(agent) {
  const file = path.join(root, `linear-${agent}-worker/src/index.ts`);
  let js = transpile(await fs.readFile(file, "utf8"));
  js = js.replaceAll('"../../shared/oauth-errors"', JSON.stringify(helperUrl));
  js = js.replaceAll('"../../shared/delivery-coordinator"', JSON.stringify(deliveryUrl));
  js = js.replaceAll('"../../shared/oauth-installation"', JSON.stringify(installationUrl));
  js = js.replaceAll('"../../shared/bridge-access-token"', JSON.stringify(bridgeTokenUrl));
  js = js.replaceAll('"../../shared/github-app-homepage"', JSON.stringify(githubHomeUrl));
  js = js.replaceAll('"../../shared/agent-location"', JSON.stringify(agentLocationUrl));
  js = js.replaceAll('"cloudflare:workers"', JSON.stringify(cloudflareStubUrl));
  return await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}
function kv(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get(key) { return map.get(key) ?? null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); }
  };
}
function makeCoordinatorNamespace(workerModule, config) {
  const actors = new Map();
  function storage() {
    const records = new Map();
    let alarm = null;
    return {
      records,
      async get(key) { return records.get(key) ?? null; },
      async put(key, value) { records.set(key, value); },
      async delete(key) { records.delete(key); },
      async list(options = {}) {
        const entries = [...records.entries()].filter(([key]) => key.startsWith(options.prefix || ""));
        return new Map(entries.slice(0, options.limit ?? entries.length));
      },
      async getAlarm() { return alarm; },
      async setAlarm(time) { alarm = time; },
    };
  }
  return {
    actors,
    idFromName(name) { return name; },
    get(id) {
      if (!actors.has(id)) {
        actors.set(id, new workerModule.DeliveryCoordinator({ storage: storage() }, config));
      }
      const actor = actors.get(id);
      return { fetch: request => actor.fetch(request) };
    }
  };
}
function env(store) {
  return {
    LINEAR_DATA: store,
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "secret",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
    LINEAR_REDIRECT_URI: "https://worker.test/oauth/callback",
    LINEAR_SCOPES: "read",
    BRIDGE_URL: "https://bridge.test/jobs",
    BRIDGE_SHARED_SECRET: "shared",
    SERVICE_NAME: "test-worker"
  };
}
async function signedEvent(id = "delivery-1") {
  const body = JSON.stringify({
    organizationId: "org", type: "AgentSessionEvent", action: "created",
    agentSessionId: "session-1", agentSession: { issueId: "issue-1" }, promptContext: "Test retry and duplicate delivery",
    webhookTimestamp: Date.now()
  });
  const signature = crypto.createHmac("sha256", "webhook-secret").update(body).digest("hex");
  return () => new Request("https://worker.test/webhook", {
    method: "POST",
    headers: {
      "linear-signature": signature,
      "linear-delivery": id,
      "linear-event": "AgentSessionEvent",
      "linear-timestamp": String(JSON.parse(body).webhookTimestamp)
    },
    body
  });
}
const installed = (expiresAt, refreshToken = "refresh") => JSON.stringify({
  organizationId: "org", accessToken: "access", expiresAt,
  refreshToken, scope: "read", installedAt: "2026-10-28T00:00:00Z"
});
const agents = ["antigravity", "chatgpt", "chatgpt-cli", "gemini", "trae", "mock"];

test("antigravity: resolves initiative membership from association records when project connection is empty", { concurrency: false }, async () => {
  const workerModule = await loadWorker("antigravity");
  const store = kv({ "installation:org": installed(Date.now() + 3600000) });
  const config = env(store);
  config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
  const request = await signedEvent("initiative-association-recovery");
  const oldFetch = globalThis.fetch;
  let delivered;
  let associationQueries = 0;
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url).includes("api.linear.app/graphql")) {
        const body = JSON.parse(String(options.body));
        if (body.query.includes("AgentActivityCreate")) {
          return Response.json({ data: { agentActivityCreate: { success: true } } });
        }
        if (body.query.includes("BridgeIssueRouting")) {
          return Response.json({ data: { issue: {
            project: { id: "eaf694c0-6845-473c-a102-bb1a1729f4bc", name: "Agent Bridge | Core", initiatives: { nodes: [] } },
            labels: { nodes: [] },
          } } });
        }
        if (body.query.includes("BridgeProjectInitiatives")) {
          associationQueries++;
          return Response.json({ data: { initiativeToProjects: {
            nodes: [{ project: { id: "eaf694c0-6845-473c-a102-bb1a1729f4bc" },
              initiative: { id: "65dc9ea9-8b90-46ed-ab59-10e507c033cc" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } } });
        }
        throw new Error("Unexpected GraphQL query");
      }
      if (String(url).includes("bridge.test")) {
        delivered = JSON.parse(String(options.body));
        return Response.json({ ok: true, accepted: true }, { status: 202 });
      }
      throw new Error("Unexpected external fetch: " + url);
    };
    const response = await workerModule.default.fetch(request(), config, {});
    assert.equal(response.status, 200);
    assert.equal(associationQueries, 1);
    assert.deepEqual(delivered.routing.initiativeIds, ["65dc9ea9-8b90-46ed-ab59-10e507c033cc"]);
    assert.equal(delivered.routing.projectId, "eaf694c0-6845-473c-a102-bb1a1729f4bc");
  } finally { globalThis.fetch = oldFetch; }
});

test("antigravity: nested session issue ID is used for routing", { concurrency: false }, async () => {
  const workerModule = await loadWorker("antigravity");
  const store = kv({ "installation:org": installed(Date.now() + 3600000) });
  const config = env(store);
  config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
  const body = JSON.stringify({ organizationId: "org", type: "AgentSessionEvent", action: "created",
    agentSessionId: "session-nested", data: { agentSession: { issueId: "issue-nested" } },
    promptContext: "Run task", webhookTimestamp: Date.now() });
  const signature = crypto.createHmac("sha256", "webhook-secret").update(body).digest("hex");
  const request = new Request("https://worker.test/webhook", { method: "POST",
    headers: { "linear-signature": signature, "linear-delivery": "nested-issue",
      "linear-event": "AgentSessionEvent" }, body });
  const oldFetch = globalThis.fetch;
  let forwarded = null;
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url).includes("api.linear.app/graphql")) {
        const body = JSON.parse(String(options.body));
        if (body.query.includes("AgentActivityCreate"))
          return Response.json({ data: { agentActivityCreate: { success: true } } });
        assert.equal(body.variables.issueId, "issue-nested");
        return Response.json({ data: { issue: { project: { id: "project-id", name: "Project",
          initiatives: { nodes: [{ id: "65dc9ea9-8b90-46ed-ab59-10e507c033cc" }] } }, labels: { nodes: [] } } } });
      }
      if (String(url).includes("bridge.test")) {
        forwarded = JSON.parse(String(options.body));
        return Response.json({ ok: true, accepted: true }, { status: 202 });
      }
      throw Error("Unexpected request");
    };
    const result = await workerModule.default.fetch(request, config, {});
    assert.equal(result.status, 200);
    assert.equal(forwarded.issueId, "issue-nested");
    assert.equal(forwarded.routing.projectId, "project-id");
  } finally { globalThis.fetch = oldFetch; }
});

test("antigravity: routing lookup failure reports Linear error without claiming bridge job", { concurrency: false }, async () => {
  const workerModule = await loadWorker("antigravity");
  const store = kv({ "installation:org": installed(Date.now() + 3600000) });
  const config = env(store);
  config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
  const request = await signedEvent("missing-routing");
  const oldFetch = globalThis.fetch;
  let forwarded = 0;
  let errors = [];
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url).includes("api.linear.app/graphql")) {
        const body = JSON.parse(String(options.body));
        if (body.query.includes("AgentActivityCreate")) {
          errors.push(body.variables.input);
          return Response.json({ data: { agentActivityCreate: { success: true } } });
        }
        return Response.json({ data: { issue: { project: null, labels: { nodes: [] } } } });
      }
      if (String(url).includes("bridge.test")) {
        forwarded++;
        return Response.json({ ok: true, accepted: true }, { status: 202 });
      }
      throw Error("Unexpected request");
    };
    const response = await workerModule.default.fetch(request(), config, {});
    assert.equal(response.status, 503);
    assert.equal((await response.json()).category, "missing_project");
    assert.equal(forwarded, 0);
    const error = errors.find(item => item.content.type === "error");
    assert.ok(error);
    assert.match(error.content.body, /No job was dispatched/);
    assert.equal([...store.map.keys()].some(key => key.startsWith("webhook:")), false);
  } finally { globalThis.fetch = oldFetch; }
});

test("antigravity: no session ID cannot forward a job with null routing", { concurrency: false }, async () => {
  const worker = await loadWorker("antigravity");
  const store = kv({ "installation:org": installed(Date.now() + 3600000) });
  const config = env(store);
  config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(worker, config);
  const body = JSON.stringify({ organizationId: "org", type: "AgentSessionEvent",
    action: "prompted", agentSession: { issueId: "issue-1" },
    agentActivity: { content: { body: "Follow up" } }, webhookTimestamp: Date.now() });
  const signature = crypto.createHmac("sha256", "webhook-secret").update(body).digest("hex");
  const request = new Request("https://worker.test/webhook", { method: "POST",
    headers: { "linear-signature": signature, "linear-event": "AgentSessionEvent" }, body });
  const oldFetch = globalThis.fetch;
  let bridgeCalls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url).includes("api.linear.app/graphql"))
        return Response.json({ data: { issue: { project: null, labels: { nodes: [] } } } });
      if (String(url).includes("bridge.test")) {
        bridgeCalls++;
        return Response.json({ ok: true, accepted: true }, { status: 202 });
      }
      throw Error("Unexpected URL");
    };
    const response = await worker.default.fetch(request, config, {});
    assert.equal(response.status, 503);
    assert.equal((await response.json()).category, "missing_project");
    assert.equal(bridgeCalls, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test("antigravity: no session ID still enriches routing from a verified issue", { concurrency: false }, async () => {
  const worker = await loadWorker("antigravity");
  const store = kv({ "installation:org": installed(Date.now() + 3600000) });
  const config = env(store);
  config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(worker, config);
  const body = JSON.stringify({ organizationId: "org", type: "AgentSessionEvent",
    action: "prompted", agentSession: { issueId: "issue-1" },
    agentActivity: { content: { body: "Follow up" } }, webhookTimestamp: Date.now() });
  const signature = crypto.createHmac("sha256", "webhook-secret").update(body).digest("hex");
  const request = new Request("https://worker.test/webhook", { method: "POST",
    headers: { "linear-signature": signature, "linear-event": "AgentSessionEvent" }, body });
  const oldFetch = globalThis.fetch;
  let delivered;
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url).includes("api.linear.app/graphql"))
        return Response.json({ data: { issue: { project: { id: "eaf694c0-6845-473c-a102-bb1a1729f4bc",
          name: "Agent Bridge | Core", initiatives: { nodes: [{ id: "65dc9ea9-8b90-46ed-ab59-10e507c033cc" }] } },
          labels: { nodes: [] } } } });
      if (String(url).includes("bridge.test")) {
        delivered = JSON.parse(String(options.body));
        return Response.json({ ok: true, accepted: true }, { status: 202 });
      }
      throw Error("Unexpected URL");
    };
    const response = await worker.default.fetch(request, config, {});
    assert.equal(response.status, 200);
    assert.equal(delivered.routing.projectId, "eaf694c0-6845-473c-a102-bb1a1729f4bc");
    assert.deepEqual(delivered.routing.initiativeIds, ["65dc9ea9-8b90-46ed-ab59-10e507c033cc"]);
  } finally { globalThis.fetch = oldFetch; }
});

test("antigravity: completion callback preserves explicit activity type", { concurrency: false }, async () => {
  const workerModule = await loadWorker("antigravity");
  const store = kv({
    "installation:org": installed(Date.now() + 3600000),
    "agent-session:session-1": "org",
  });
  const config = env(store);
  config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
  const oldFetch = globalThis.fetch;
  let activityInput;
  try {
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /api\.linear\.app\/graphql/);
      activityInput = JSON.parse(String(options.body)).variables.input;
      return Response.json({ data: { agentActivityCreate: { success: true } } });
    };
    const response = await workerModule.default.fetch(new Request("https://worker.test/complete", {
      method: "POST",
      headers: { authorization: "Bearer shared", "content-type": "application/json" },
      body: JSON.stringify({
        agentSessionId: "session-1",
        activityType: "thought",
        body: "AGY started locally",
      }),
    }), config, {});
    assert.equal(response.status, 200);
    assert.deepEqual(activityInput.content, { type: "thought", body: "AGY started locally" });
  } finally { globalThis.fetch = oldFetch; }
});

test("trae: completion callback preserves explicit progress activity type", { concurrency: false }, async () => {
  const workerModule = await loadWorker("trae");
  const store = kv({
    "installation:org": installed(Date.now() + 3600000),
    "agent-session:session-1": "org",
  });
  const config = env(store);
  config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
  const oldFetch = globalThis.fetch;
  let activityInput;
  try {
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /api\.linear\.app\/graphql/);
      activityInput = JSON.parse(String(options.body)).variables.input;
      return Response.json({ data: { agentActivityCreate: { success: true } } });
    };
    const response = await workerModule.default.fetch(new Request("https://worker.test/complete", {
      method: "POST",
      headers: { authorization: "Bearer shared", "content-type": "application/json" },
      body: JSON.stringify({
        agentSessionId: "session-1",
        activityType: "thought",
        body: "Editing project files",
      }),
    }), config, {});
    assert.equal(response.status, 200);
    assert.deepEqual(activityInput.content, { type: "thought", body: "Editing project files" });
  } finally { globalThis.fetch = oldFetch; }
});

for (const agent of agents) {
  test(`${agent}: expired OAuth does not poison dedupe; reauthorization permits retry`, { concurrency: false }, async () => {
    const workerModule = await loadWorker(agent);
    const worker = workerModule.default;
    const store = kv({ "installation:org": installed(Date.now() - 10000) });
    const config = env(store);
    config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
    let request = await signedEvent("expired-token-" + agent);
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = async url => {
        if (String(url).includes("/oauth/token")) return new Response('{"error":"invalid_grant"}', { status: 400 });
        throw new Error("Unexpected external fetch: " + url);
      };
      const failed = await worker.fetch(request(), config, {});
      assert.equal(failed.status, 503);
      assert.equal((await failed.json()).error, "reauthorization_required");
      assert.equal([...store.map.keys()].some(key => key.startsWith("webhook:")), false);

      store.map.set("installation:org", installed(Date.now() + 3600000));
      let forwarded = 0;
      globalThis.fetch = async url => {
        if (String(url).includes("api.linear.app/graphql")) {
          return Response.json({ data: { agentActivityCreate: { success: true },
            issue: { identifier: "REV-123", project: { id: "project-1", name: "Metrics", initiatives: { nodes: [{ id: "65dc9ea9-8b90-46ed-ab59-10e507c033cc" }] } } }
          } });
        }
        if (String(url).includes("bridge.test")) {
          forwarded++;
          return Response.json({ ok: true, accepted: true }, { status: 202 });
        }
        throw new Error("Unexpected external fetch: " + url);
      };
      // Reauthorization may take longer than the replay window; model a fresh Linear delivery.
      request = await signedEvent("expired-token-" + agent);
      const accepted = await worker.fetch(request(), config, {});
      assert.equal(accepted.status, 200);
      assert.equal(forwarded, 1);
      const duplicate = await worker.fetch(request(), config, {});
      assert.equal(duplicate.status, 200);
      assert.equal((await duplicate.json()).duplicate, true);
      assert.equal(forwarded, 1);
    } finally { globalThis.fetch = oldFetch; }
  });
  test(`${agent}: bridge outage retains retryability until accepted`, { concurrency: false }, async () => {
    const workerModule = await loadWorker(agent);
    const worker = workerModule.default;
    const store = kv({ "installation:org": installed(Date.now() + 3600000) });
    const config = env(store);
    config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
    const request = await signedEvent("bridge-outage-" + agent);
    const oldFetch = globalThis.fetch;
    let attempts = 0;
    let startActivities = 0;
    const activityInputs = [];
    try {
      globalThis.fetch = async (url, options) => {
        if (String(url).includes("api.linear.app/graphql")) {
          if (String(options?.body || "").includes("AgentActivityCreate")) {
            startActivities++;
            activityInputs.push(JSON.parse(String(options.body)).variables.input);
          }
          return Response.json({ data: { agentActivityCreate: { success: true },
            issue: { identifier: "REV-123", project: { id: "project-1", name: "Metrics", initiatives: { nodes: [{ id: "65dc9ea9-8b90-46ed-ab59-10e507c033cc" }] } } }
          } });
        }
        if (String(url).includes("bridge.test")) {
          attempts++;
          return attempts === 1 ? new Response("Unavailable", { status: 503 }) :
            Response.json({ ok: true, accepted: true }, { status: 202 });
        }
        throw new Error("Unexpected external fetch: " + url);
      };
      const failed = await worker.fetch(request(), config, {});
      assert.equal(failed.status, 503);
      assert.equal([...store.map.keys()].some(key => key.startsWith("webhook:")), false);
      const retried = await worker.fetch(request(), config, {});
      assert.equal(retried.status, 200);
      assert.equal(attempts, 2);
      assert.equal(startActivities, agent === "antigravity" ? 2 : 1,
        "one receipt acknowledgment plus one failure activity for Antigravity; no duplicates on retry");
      if (agent === "antigravity") {
        const failure = activityInputs.find(input => input.content.type === "error");
        assert.ok(failure, "bridge rejection must publish an error");
        assert.match(failure.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        assert.match(failure.content.body, /launch was rejected by the bridge/);
      }
    } finally { globalThis.fetch = oldFetch; }
  });
}

for (const agent of agents) {
  test(`${agent}: atomic per-organization delivery serialization prevents concurrent duplicate forwarding`, { concurrency: false }, async () => {
    const workerModule = await loadWorker(agent);
    const worker = workerModule.default;
    const store = kv({ "installation:org": installed(Date.now() + 3600000) });
    const config = env(store);
    config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
    const request = await signedEvent("concurrent-" + agent);
    const oldFetch = globalThis.fetch;
    let forwarded = 0;
    try {
      globalThis.fetch = async url => {
        if (String(url).includes("api.linear.app/graphql")) {
          return Response.json({ data: { agentActivityCreate: { success: true },
            issue: { identifier: "REV-123", project: { id: "project-1", name: "Metrics", initiatives: { nodes: [{ id: "65dc9ea9-8b90-46ed-ab59-10e507c033cc" }] } } }
          } });
        }
        if (String(url).includes("bridge.test")) {
          forwarded++;
          await new Promise(resolve => setTimeout(resolve, 10));
          return Response.json({ ok: true, accepted: true }, { status: 202 });
        }
        throw new Error("Unexpected external fetch: " + url);
      };
      const responses = await Promise.all([
        worker.fetch(request(), config, {}),
        worker.fetch(request(), config, {})
      ]);
      assert.deepEqual(responses.map(response => response.status), [200, 200]);
      assert.equal(forwarded, 1);
    } finally { globalThis.fetch = oldFetch; }
  });

  test(`${agent}: alarm replay recovers delivery without new Linear webhook`, { concurrency: false }, async () => {
    const workerModule = await loadWorker(agent);
    const worker = workerModule.default;
    const store = kv({ "installation:org": installed(Date.now() + 3600000) });
    const config = env(store);
    config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
    const request = await signedEvent("alarm-" + agent);
    const oldFetch = globalThis.fetch;
    let forwarded = 0;
    try {
      globalThis.fetch = async url => {
        if (String(url).includes("api.linear.app/graphql")) {
          return Response.json({ data: { agentActivityCreate: { success: true },
            issue: { identifier: "REV-123", project: { id: "project-1", name: "Metrics", initiatives: { nodes: [{ id: "65dc9ea9-8b90-46ed-ab59-10e507c033cc" }] } } }
          } });
        }
        if (String(url).includes("bridge.test")) {
          forwarded++;
          return forwarded === 1 ? new Response("offline", { status: 503 }) :
            Response.json({ ok: true, accepted: true }, { status: 202 });
        }
        throw new Error("Unexpected external fetch: " + url);
      };
      assert.equal((await worker.fetch(request(), config, {})).status, 503);
      const actor = [...config.DELIVERY_COORDINATOR.actors.values()][0];
      const storage = actor.ctx.storage;
      const entry = [...storage.records.entries()].find(([key]) => key.startsWith("pending:"));
      assert.ok(entry);
      storage.records.set(entry[0], { ...entry[1], nextAttemptAt: Date.now() - 1 });
      await actor.alarm();
      assert.equal(forwarded, 2);
      assert.equal([...storage.records.keys()].some(key => key.startsWith("pending:")), false);
      assert.equal([...storage.records.keys()].some(key => key.startsWith("accepted:")), true);
    } finally { globalThis.fetch = oldFetch; }
  });
}

test("all Workers reject invalid webhook freshness before Durable Object access", { concurrency: false }, async () => {
  for (const agent of agents) {
    const workerModule = await loadWorker(agent);
    const worker = workerModule.default;
    const config = env(kv());
    let calls = 0;
    config.DELIVERY_COORDINATOR = {
      idFromName() { calls++; throw Error("DO must not be reached"); },
    };
    for (const [description, offset, headerOverride, bodyOverride] of [
      ["old", -120000, null, null],
      ["future", 120000, null, null],
      ["missing timestamp", 0, null, "missing"],
      ["wrong header", 0, "1234567890123", null],
      ["malformed header", 0, "not-a-timestamp", null],
    ]) {
      const payload = {
        organizationId: "org", type: "AgentSessionEvent",
        action: "created", agentSessionId: "session-1",
      };
      if (bodyOverride !== "missing") payload.webhookTimestamp = Date.now() + offset;
      const body = JSON.stringify(payload);
      const signature = crypto.createHmac("sha256", "webhook-secret").update(body).digest("hex");
      const timestamp = headerOverride ?? String(payload.webhookTimestamp ?? "");
      const response = await worker.fetch(new Request("https://worker.test/webhook", {
        method: "POST",
        headers: { "linear-signature": signature, ...(bodyOverride === "missing" ? {} : { "linear-timestamp": timestamp }) },
        body,
      }), config, {});
      assert.equal(response.status, 401, agent + ": " + description);
    }
    assert.equal(calls, 0, agent + ": invalid delivery reached DO");
  }
});
test("freshness accepts boundary and rejects timestamp mismatch", async () => {
  const { validateWebhookFreshness, WEBHOOK_FRESHNESS_WINDOW_MS } = await import(deliveryUrl);
  const now = 1760000000000;
  assert.equal(validateWebhookFreshness({ webhookTimestamp: now }, String(now), now), true);
  assert.equal(validateWebhookFreshness({ webhookTimestamp: now - WEBHOOK_FRESHNESS_WINDOW_MS }, String(now - WEBHOOK_FRESHNESS_WINDOW_MS), now), true);
  assert.equal(validateWebhookFreshness({ webhookTimestamp: now + WEBHOOK_FRESHNESS_WINDOW_MS }, String(now + WEBHOOK_FRESHNESS_WINDOW_MS), now), true);
  assert.equal(validateWebhookFreshness({ webhookTimestamp: now + WEBHOOK_FRESHNESS_WINDOW_MS + 1 }, null, now), false);
  assert.equal(validateWebhookFreshness({ webhookTimestamp: now }, String(now + 1), now), false);
});

test("replayed signed body cannot bypass dedupe by changing unsigned delivery header", { concurrency: false }, async () => {
  const workerModule = await loadWorker("mock");
  const config = env(kv({ "installation:org": installed(Date.now() + 3600000) }));
  config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
  const create = await signedEvent("original-header");
  const oldFetch = globalThis.fetch;
  let forwarded = 0;
  try {
    globalThis.fetch = async url => {
      if (String(url).includes("api.linear.app/graphql")) {
        return Response.json({ data: { agentActivityCreate: { success: true },
          issue: { identifier: "REV-123", project: { id: "project-1", name: "Metrics", initiatives: { nodes: [{ id: "65dc9ea9-8b90-46ed-ab59-10e507c033cc" }] } } } } });
      }
      if (String(url).includes("bridge.test")) {
        forwarded++;
        return Response.json({ ok: true, accepted: true }, { status: 202 });
      }
      throw new Error("Unexpected external fetch: " + url);
    };
    assert.equal((await workerModule.default.fetch(create(), config, {})).status, 200);
    for (const alternate of ["attacker-modified", null]) {
      const replay = create();
      if (alternate === null) replay.headers.delete("linear-delivery");
      else replay.headers.set("linear-delivery", alternate);
      assert.equal((await workerModule.default.fetch(replay, config, {})).status, 200);
    }
    assert.equal(forwarded, 1);
  } finally { globalThis.fetch = oldFetch; }
});

test("trae: Agent Location label is forwarded to the Ubuntu bridge", { concurrency: false }, async () => {
  const workerModule = await loadWorker("trae");
  const store = kv({ "installation:org": installed(Date.now() + 3600000) });
  const config = env(store);
  config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
  const request = await signedEvent("mac-location-trae");
  const original = globalThis.fetch;
  let forwarded;
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url).includes("api.linear.app/graphql")) {
        const input = JSON.parse(options.body);
        if (String(input.query).includes("BridgeIssueRouting")) {
          return Response.json({ data: {
            issue: { project: { id: "project-1", name: "Metrics", initiatives: { nodes: [{ id: "65dc9ea9-8b90-46ed-ab59-10e507c033cc" }] } },
              labels: { nodes: [{ name: "macos", parent: { name: "agent-location" } }] } }
          } });
        }
        return Response.json({ data: { agentActivityCreate: { success: true } } });
      }
      if (String(url).includes("bridge.test")) {
        forwarded = JSON.parse(options.body);
        return Response.json({ ok: true, accepted: true }, { status: 202 });
      }
      throw Error("Unexpected test fetch: " + url);
    };
    const response = await workerModule.default.fetch(request(), config, {});
    assert.equal(response.status, 200);
    assert.equal(forwarded.routing.agentLocation, "macos");
    assert.equal(forwarded.routing.projectId, "project-1");
  } finally { globalThis.fetch = original; }
});
