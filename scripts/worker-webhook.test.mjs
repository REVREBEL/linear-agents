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
const cloudflareStubUrl = "data:text/javascript;base64," + Buffer.from(
  "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
).toString("base64");

async function loadWorker(agent) {
  const file = path.join(root, `linear-${agent}-worker/src/index.ts`);
  let js = transpile(await fs.readFile(file, "utf8"));
  js = js.replaceAll('"../../shared/oauth-errors"', JSON.stringify(helperUrl));
  js = js.replaceAll('"../../shared/delivery-coordinator"', JSON.stringify(deliveryUrl));
  js = js.replaceAll('"../../shared/oauth-installation"', JSON.stringify(installationUrl));
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
    agentSessionId: "session-1", agentSession: { issueId: "issue-1" }, promptContext: "Test retry and duplicate delivery"
  });
  const signature = crypto.createHmac("sha256", "webhook-secret").update(body).digest("hex");
  return () => new Request("https://worker.test/webhook", {
    method: "POST",
    headers: {
      "linear-signature": signature,
      "linear-delivery": id,
      "linear-event": "AgentSessionEvent"
    },
    body
  });
}
const installed = (expiresAt, refreshToken = "refresh") => JSON.stringify({
  organizationId: "org", accessToken: "access", expiresAt,
  refreshToken, scope: "read", installedAt: "2026-10-28T00:00:00Z"
});
const agents = ["antigravity", "chatgpt", "gemini", "trae", "mock"];
for (const agent of agents) {
  test(`${agent}: expired OAuth does not poison dedupe; reauthorization permits retry`, { concurrency: false }, async () => {
    const workerModule = await loadWorker(agent);
    const worker = workerModule.default;
    const store = kv({ "installation:org": installed(Date.now() - 10000) });
    const config = env(store);
    config.DELIVERY_COORDINATOR = makeCoordinatorNamespace(workerModule, config);
    const request = await signedEvent("expired-token-" + agent);
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
            issue: { identifier: "REV-123", project: { id: "project-1", name: "Metrics", initiatives: { nodes: [] } } }
          } });
        }
        if (String(url).includes("bridge.test")) {
          forwarded++;
          return Response.json({ ok: true, accepted: true }, { status: 202 });
        }
        throw new Error("Unexpected external fetch: " + url);
      };
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
    try {
      globalThis.fetch = async (url, options) => {
        if (String(url).includes("api.linear.app/graphql")) {
          if (String(options?.body || "").includes("AgentActivityCreate")) startActivities++;
          return Response.json({ data: { agentActivityCreate: { success: true },
            issue: { identifier: "REV-123", project: { id: "project-1", name: "Metrics", initiatives: { nodes: [] } } }
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
      assert.equal(startActivities, 1, "started activity must be posted once across retries");
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
            issue: { identifier: "REV-123", project: { id: "project-1", name: "Metrics", initiatives: { nodes: [] } } }
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
            issue: { identifier: "REV-123", project: { id: "project-1", name: "Metrics", initiatives: { nodes: [] } } }
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
