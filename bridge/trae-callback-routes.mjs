import path from "node:path";
import { readBody, sendJson } from "./http-helpers.mjs";
import { validateRemoteTraeActivity } from "../routing/remote-trae-activity.mjs";

/**
 * HTTP ingress for Mac Trae progress and terminal completion callbacks.
 * The main bridge owns the ledger, completion publisher, workspace reader,
 * token comparator, and throttle map passed here as shared dependencies.
 */
export function createTraeCallbackRoutes({
  jobStore, projectsRoot, traeActivityState, readTraeActivityContext,
  safeTokenEqual, sanitizeTraeActivityBody, postTraeActivity,
  now = Date.now,
}) {
  async function handleActivity(request, response) {
      let activity;
      try { activity = JSON.parse(await readBody(request)); }
      catch { return sendJson(response, 400, { ok: false, error: "Invalid JSON payload" }); }
      const workspace = typeof activity.workspace === "string" ? path.resolve(activity.workspace) : "";
      let context;
      if (typeof activity.jobKey === "string" && activity.jobKey.startsWith("trae:")) {
        const record = await jobStore.get(activity.jobKey).catch(() => null);
        if (!validateRemoteTraeActivity(activity, record)) {
          return sendJson(response, 401, { ok: false, error: "Invalid remote Trae activity context" });
        }
        context = { agentSessionId: record.agentSessionId, completionUrl: record.remoteCompletionUrl };
      } else {
        const projectsRoot = path.resolve(projectsRoot);
        if (!workspace || (workspace !== projectsRoot && !workspace.startsWith(projectsRoot + path.sep))) {
          return sendJson(response, 400, { ok: false, error: "Invalid Trae workspace" });
        }
        context = await readTraeActivityContext(workspace);
        if (!context || typeof activity.token !== "string" ||
            !safeTokenEqual(activity.token, context.token) ||
            activity.agentSessionId !== context.agentSessionId) {
          return sendJson(response, 401, { ok: false, error: "Invalid Trae activity context" });
        }
      }
      const body = sanitizeTraeActivityBody(activity.body);
      if (!body) return sendJson(response, 400, { ok: false, error: "Invalid Trae activity body" });
      const now = now();
      const previous = traeActivityState.get(context.agentSessionId);
      if (previous && (now - previous.at < 10_000 ||
          (previous.body === body && now - previous.at < 60_000))) {
        return sendJson(response, 202, { ok: true, accepted: true, throttled: true });
      }
      const posted = await postTraeActivity(context, body, "thought");
      if (!posted) return sendJson(response, 502, { ok: false, error: "Unable to publish Trae activity" });
      traeActivityState.set(context.agentSessionId, { at: now, body });
      return sendJson(response, 202, { ok: true, accepted: true });
  }
  async function handleCompletion(request, response) {
      let activity;
      try { activity = JSON.parse(await readBody(request)); }
      catch { return sendJson(response, 400, { ok: false, error: "Invalid JSON payload" }); }
      if (typeof activity?.jobKey !== "string" || !activity.jobKey.startsWith("trae:")) {
        return sendJson(response, 401, { ok: false, error: "Invalid completion context" });
      }
      const record = await jobStore.get(activity.jobKey).catch(() => null);
      if (record?.state === "completed" && record.remoteActivityTokenHash &&
          validateRemoteTraeActivity(activity, { ...record, state: "awaiting_external" })) {
        return sendJson(response, 202, { ok: true, duplicate: true });
      }
      if (!validateRemoteTraeActivity(activity, record)) {
        return sendJson(response, 401, { ok: false, error: "Invalid completion context" });
      }
      if (!["completed", "failed"].includes(activity.status) ||
          typeof activity.body !== "string" || !activity.body.trim() ||
          activity.body.length > 4000) {
        return sendJson(response, 422, { ok: false, error: "Invalid terminal activity" });
      }
      const posted = await postTraeActivity(
        { agentSessionId: record.agentSessionId, completionUrl: record.remoteCompletionUrl },
        activity.body.trim(), activity.status === "completed" ? "response" : "error"
      );
      if (!posted) return sendJson(response, 502, { ok: false, error: "Linear completion not confirmed" });
      await jobStore.transition(record.key, activity.status, {
        remoteCompletionConfirmedAt: new Date().toISOString(),
        remoteCompletionStatus: activity.status,
      });
      return sendJson(response, 202, { ok: true, status: activity.status });
  }

  return async function handleTraeCallbackRoute(request, response, { url }) {
    if (request.method === "POST" && url.pathname === "/trae-activity") {
      await handleActivity(request, response);
      return true;
    }
    if (request.method === "POST" && url.pathname === "/trae-complete") {
      await handleCompletion(request, response);
      return true;
    }
    return false;
  };
}
