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
  for (const [label, host] of hosts) {
    await check(`${label} DNS`, async () => {
      const records = await dns.lookup(host, { all: true });
      if (!records.length) throw Error("No A/AAAA records");
      return `${records.length} address(es)`;
    });
    await check(`${label} Worker`, async () => {
      const data = await request(`https://${host}/health`);
      if (data?.ok !== true) throw Error("Invalid Worker health response");
      return "public route healthy";
    });
    await check(`${label} Worker → Tunnel → bridge`, async () => {
      const id = crypto.randomUUID();
      const data = await request(`https://${host}/diagnostics/probe`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "x-bridge-probe-id": id },
      });
      if (data?.ok !== true || data?.probeId !== id || data?.stage !== "bridge") {
        const description = data && typeof data === "object"
          ? `ok=${data.ok ?? "missing"}, stage=${data.stage ?? "missing"}, probeIdMatch=${data.probeId === id}, worker=${data.worker ?? "missing"}, status=${data.status ?? "n/a"}`
          : "no JSON object";
        throw Error(`Probe was not acknowledged by the local bridge (${description})`);
      }
      return `delivery confirmed (${id})`;
    });
  }
}
console.log(`\nDiagnostics: ${failures ? `${failures} check(s) failed` : "all checks passed"}`);
if (failures) process.exitCode = 1;
