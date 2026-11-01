#!/usr/bin/env node
import crypto from "node:crypto";
import dns from "node:dns/promises";

const secret = process.env.BRIDGE_SHARED_SECRET;
const hosts = [
  ["Antigravity", process.env.ANTIGRAVITY_HOST || "antigravity-agent.revrebel.io"],
  ["ChatGPT", process.env.CHATGPT_HOST || "chatgpt-agent.revrebel.io"],
  ["Trae", process.env.TRAE_HOST || "trae-agent.revrebel.io"],
  ["Gemini", process.env.GEMINI_HOST || "gemini-agent.revrebel.io"],
  ["Mock", process.env.MOCK_HOST || "mock-agent.revrebel.io"],
];
// Worker custom domains are distinct from the direct Tunnel hostnames.
// Read the same per-agent prefixes used by wrangler.jsonc.
const domain = process.env.DOMAIN || "revrebel.io";
const workers = [
  ["Antigravity", process.env.ANTIGRAVITY_WORKER_HOST || `linear-${process.env.ANTIGRAVITY_PREFIX || "antigravity"}.${domain}`],
  ["ChatGPT", process.env.CHATGPT_WORKER_HOST || `linear-${process.env.CHATGPT_PREFIX || "chatgpt"}.${domain}`],
  ["Trae", process.env.TRAE_WORKER_HOST || `linear-${process.env.TRAE_PREFIX || "trae"}.${domain}`],
  ["Gemini", process.env.GEMINI_WORKER_HOST || `linear-${process.env.GEMINI_PREFIX || "gemini"}.${domain}`],
  ["Mock", process.env.MOCK_WORKER_HOST || `linear-${process.env.MOCK_PREFIX || "mock"}.${domain}`],
];
const timeoutMs = 9000;
let failures = 0;

async function check(label, action) {
  try {
    const message = await action();
    console.log(`PASS ${label}: ${message}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${label}: ${error.message}`);
  }
}
async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
  });
  const contentType = response.headers.get("content-type") || "missing";
  const ray = response.headers.get("cf-ray");
  const details = `HTTP ${response.status}, content-type=${contentType}${ray ? `, cf-ray=${ray}` : ""}`;
  if (response.status >= 300 && response.status < 400) {
    // Do not echo redirected URLs; they may contain authentication state.
    throw Error(`${details}; redirected (possible Cloudflare Access login)`);
  }
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null) : null;
  if (!response.ok) throw Error(details);
  if (body === null) {
    throw Error(`${details}; expected JSON (possible WAF challenge or proxy response)`);
  }
  return body;
}

await check("Local router", async () => {
  const data = await request("http://127.0.0.1:8788/health");
  if (!data?.ok || data.service !== "local-linear-agent-router") throw Error("Invalid health response");
  return "healthy";
});

if (!secret) {
  console.error("SKIP External probes: BRIDGE_SHARED_SECRET is absent from the local .env");
  process.exitCode = 1;
} else {
  for (const [label, workerHost] of workers) {
    await check(`${label} Worker → Tunnel → bridge`, async () => {
      const id = crypto.randomUUID();
      const data = await request(`https://${workerHost}/diagnostics/probe`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "x-bridge-probe-id": id },
      });
      if (data?.ok !== true || data?.stage !== "bridge" ||
          data?.probeId !== id || typeof data.worker !== "string" ||
          data.bridge !== "local-linear-agent-router") {
        throw Error(`Worker forwarding not confirmed (ok=${data?.ok}, stage=${data?.stage}, idMatch=${data?.probeId === id}, bridge=${data?.bridge})`);
      }
      return `Worker and bridge independently acknowledged ${id}`;
    });
  }
  for (const [label, host] of hosts) {
    await check(`${label} DNS`, async () => {
      const records = await dns.lookup(host, { all: true });
      if (!records.length) throw Error("No A/AAAA records");
      return `${records.length} address(es)`;
    });
    await check(`${label} Tunnel-host health`, async () => {
      const data = await request(`https://${host}/health`);
      if (data?.ok !== true) throw Error("Invalid Worker health response");
      return "public route healthy";
    });
    await check(`${label} public probe`, async () => {
      const id = crypto.randomUUID();
      const data = await request(`https://${host}/diagnostics/probe`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "x-bridge-probe-id": id },
      });
      if (data?.ok !== true || data?.probeId !== id) {
        const description = data && typeof data === "object"
          ? `ok=${data.ok ?? "missing"}, stage=${data.stage ?? "missing"}, probeIdMatch=${data.probeId === id}, worker=${data.worker ?? "missing"}, status=${data.status ?? "n/a"}`
          : "no JSON object";
        throw Error(`Probe was not acknowledged by the local bridge (${description})`);
      }
      if (data.stage === "bridge" && typeof data.worker === "string") {
        return `Worker → Tunnel → bridge confirmed (${id})`;
      }
      if (data.service === "local-linear-agent-router") {
        return `Tunnel → bridge confirmed (${id}); public hostname appears to bypass Worker`;
      }
      throw Error("Probe ID acknowledged but response origin is not identifiable");
    });
  }
}
console.log(`\nDiagnostics: ${failures ? `${failures} check(s) failed` : "all checks passed"}`);
if (failures) process.exitCode = 1;
