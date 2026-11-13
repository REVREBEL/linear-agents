import { sendJson } from "./http-helpers.mjs";

/**
 * Stateless HTTP transport handler for diagnostics. The caller owns all runtime
 * configuration, agent-host routing, authentication and the server listener.
 * Return true when a route was handled, false for other paths/methods.
 */
export function createDiagnosticRoutes({ health, sharedSecret, agentForHost }) {
  return function handleDiagnosticRoute(request, response, { host, url }) {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "local-linear-agent-router", host, ...health });
      return true;
    }

    // Probe is authenticated and side-effect free: it does not claim jobs,
    // write ledgers, or launch an agent.
    if (request.method === "POST" && url.pathname === "/diagnostics/probe") {
      if (!sharedSecret || request.headers.authorization !== `Bearer ${sharedSecret}`) {
        sendJson(response, 401, { ok: false, error: "Unauthorized" });
        return true;
      }
      const probeId = request.headers["x-bridge-probe-id"];
      if (typeof probeId !== "string" || !/^[a-f0-9-]{36}$/i.test(probeId)) {
        sendJson(response, 400, { ok: false, error: "Invalid probe ID" });
        return true;
      }
      sendJson(response, 200, {
        ok: true,
        probeId,
        service: "local-linear-agent-router",
        agent: agentForHost(host),
      });
      return true;
    }

    return false;
  };
}
