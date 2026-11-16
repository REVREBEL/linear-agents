import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Compose the non-/jobs routes in their established priority order.
 * Return true only if a route handled the request; the bridge owns /jobs
 * admission, its shared-secret guard, 404s, error boundaries and HTTP server.
 */
export function createHttpRouteComposer({
  handleDiagnosticRoute, handleReviewRoute, handleGithubWebhookRoute,
  handleTraeCallbackRoute, handleIssueCompletionRoute,
  jobsDir, readBody, sendJson, env = process.env, logger = console,
}) {
  const send = (response, status, body) => {
    sendJson(response, status, body);
    return true;
  };
  return async function handleComposedRoutes(request, response, { host, url }) {
    if (handleDiagnosticRoute(request, response, { host, url })) return true;

    // Shortcuts may construct a URL with &handoffid= before ?result.
    const legacyMatch = /^\/github\/handoff-result&handoffid=([a-zA-Z0-9_-]{8,128})$/.exec(url.pathname);
    if (request.method === "GET" &&
        (url.pathname === "/github/handoff-result" || legacyMatch)) {
      const handoffId = legacyMatch?.[1] ||
        url.searchParams.get("handoffid") || url.searchParams.get("handoffId");
      const allowed = { success: "success", cancelled: "cancelled", error: "error",
        "x-success": "success", "x-cancelled": "cancelled", "x-error": "error" };
      const outcomeFlags = [...url.searchParams.keys()].filter(key => Object.hasOwn(allowed, key));
      if (outcomeFlags.length !== 1 ||
          (handoffId !== null && !/^[a-zA-Z0-9_-]{8,128}$/.test(handoffId))) {
        return send(response, 400, {
          ok: false, error: "Use ?success, ?cancelled or ?error, optionally with handoffid",
        });
      }
      const status = allowed[outcomeFlags[0]];
      const record = { at: new Date().toISOString(), status, source: "shortcuts", stage: "handoff",
        ...(handoffId ? { handoffId } : {}) };
      const resultDir = path.join(jobsDir, "chatgpt", "handoff-results");
      await fs.mkdir(resultDir, { recursive: true, mode: 0o700 });
      await fs.appendFile(path.join(resultDir, "results.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
      logger.log(`ChatGPT Shortcut signal: ${status} ${handoffId || "(unassigned)"}`);
      return send(response, 200, { ok: true, status, ...(handoffId ? { handoffId } : {}) });
    }

    if (url.pathname === "/github/handoff-result") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return send(response, 405, { ok: false, error: "Use POST to report a Shortcut handoff result" });
      }
      const callbackToken = env.CHATGPT_HANDOFF_CALLBACK_TOKEN;
      if (!callbackToken) return send(response, 503, {
        ok: false, error: "Shortcut callback token not configured",
      });
      const supplied = request.headers.authorization;
      const expected = `Bearer ${callbackToken}`;
      if (typeof supplied !== "string" ||
          Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        return send(response, 401, { ok: false, error: "Unauthorized" });
      }
      let payload;
      try { payload = JSON.parse(await readBody(request)); }
      catch { return send(response, 400, { ok: false, error: "Invalid JSON payload" }); }
      const { handoffId, status, stage } = payload || {};
      if (typeof handoffId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(handoffId) ||
          !["success", "error"].includes(status) ||
          typeof stage !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(stage) ||
          (payload.error !== undefined && (typeof payload.error !== "string" || payload.error.length > 500))) {
        return send(response, 400, { ok: false, error: "Invalid handoff result" });
      }
      const record = { at: new Date().toISOString(), handoffId, status, stage,
        ...(status === "error" && payload.error ? { error: payload.error } : {}) };
      const resultDir = path.join(jobsDir, "chatgpt", "handoff-results");
      await fs.mkdir(resultDir, { recursive: true, mode: 0o700 });
      await fs.appendFile(path.join(resultDir, "results.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
      logger.log(`ChatGPT Shortcut handoff result: ${handoffId} ${status} ${stage}`);
      return send(response, 202, { ok: true, accepted: true, handoffId, status });
    }

    if (await handleReviewRoute(request, response, { url })) return true;
    if (await handleGithubWebhookRoute(request, response, { url })) return true;
    if (await handleTraeCallbackRoute(request, response, { url })) return true;
    if (await handleIssueCompletionRoute(request, response, { url })) return true;
    return false;
  };
}
