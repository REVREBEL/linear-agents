import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperSource = await fs.readFile(path.join(root, "shared/oauth-errors.ts"), "utf8");
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const helperUrl = "data:text/javascript;base64," + Buffer.from(transpile(helperSource)).toString("base64");

async function loadWorker(agent) {
  const file = path.join(root, `linear-${agent}-worker/src/index.ts`);
  let js = transpile(await fs.readFile(file, "utf8"));
  js = js.replaceAll('"../../shared/oauth-errors"', JSON.stringify(helperUrl));
  return (await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"))).default;
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
    agentSessionId: "session-1", promptContext: "Test retry and duplicate delivery"
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
    const worker = await loadWorker(agent);
    const store = kv({ "installation:org": installed(Date.now() - 10000) });
    const config = env(store);
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
        if (String(url).includes("api.linear.app/graphql"))
          return Response.json({ data: { agentActivityCreate: { success: true } } });
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
    const worker = await loadWorker(agent);
    const store = kv({ "installation:org": installed(Date.now() + 3600000) });
    const config = env(store);
    const request = await signedEvent("bridge-outage-" + agent);
    const oldFetch = globalThis.fetch;
    let attempts = 0;
    try {
      globalThis.fetch = async url => {
        if (String(url).includes("api.linear.app/graphql"))
          return Response.json({ data: { agentActivityCreate: { success: true } } });
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
    } finally { globalThis.fetch = oldFetch; }
  });
}
