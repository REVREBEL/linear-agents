#!/usr/bin/env node
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Read-only, loopback-only smoke checks for an already-running Agent Bridge.
 * Never sends POST /jobs, invokes a launcher, or alters production state.
 * Requires the bridge secret from the environment for an authenticated
 * diagnostic probe, but never prints or serializes it.
 */
export async function runBridgeSmoke({
  port = process.env.BRIDGE_PORT || "8788",
  sharedSecret = process.env.BRIDGE_SHARED_SECRET,
  fetchImpl = fetch,
  logger = console,
  probeId = crypto.randomUUID(),
} = {}) {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw Error("BRIDGE_PORT must be an integer between 1 and 65535");
  }
  if (typeof sharedSecret !== "string" || sharedSecret.length === 0) {
    throw Error("BRIDGE_SHARED_SECRET is required for an authenticated local smoke test");
  }
  if (!/^[a-f0-9-]{36}$/i.test(probeId)) throw Error("Invalid diagnostic probe ID");
  // Intentionally ignores BRIDGE_HOST and external URLs. A remote target
  // would make this a potentially destructive or unauthenticated scan.
  const base = `http://127.0.0.1:${parsedPort}`;
  async function request(endpoint, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetchImpl(base + endpoint, {
        ...options,
        signal: controller.signal,
        redirect: "error",
      });
      const body = await response.json();
      return { status: response.status, body };
    } finally { clearTimeout(timeout); }
  }
  const health = await request("/health", { method: "GET" });
  if (health.status !== 200 || health.body?.ok !== true ||
      health.body?.service !== "local-linear-agent-router") {
    throw Error("Bridge health check failed");
  }
  const unauthorized = await request("/diagnostics/probe", {
    method: "POST",
    headers: { "x-bridge-probe-id": probeId },
  });
  if (unauthorized.status !== 401 || unauthorized.body?.ok !== false) {
    throw Error("Unauthenticated diagnostic probe was not rejected");
  }
  const probe = await request("/diagnostics/probe", {
    method: "POST",
    headers: {
      authorization: `Bearer ${sharedSecret}`,
      "x-bridge-probe-id": probeId,
    },
  });
  if (probe.status !== 200 || probe.body?.ok !== true ||
      probe.body?.probeId !== probeId ||
      probe.body?.service !== "local-linear-agent-router" ||
      typeof probe.body?.agent !== "string") {
    throw Error("Authenticated diagnostic probe did not match the request");
  }
  logger.log("PASS: loopback bridge health, unauthorized rejection, and authenticated probe");
  return { ok: true, service: health.body.service, agent: probe.body.agent };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBridgeSmoke().catch(error => {
    // Never print headers or environment values on failures.
    console.error("FAIL: bridge smoke check:", error.message);
    process.exitCode = 1;
  });
}
