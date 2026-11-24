import crypto from "node:crypto";
import { readBody, sendJson } from "../server/http-helpers.mjs";
import { persistNoPromptIntake } from "../../integrations/event-intelligence-intake.mjs";

function sameSecret(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string" ||
      expected.length < 32 || Buffer.byteLength(candidate) !== Buffer.byteLength(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

/**
 * New private HTTP inbox on the existing bridge listener. The Worker has
 * already validated Linear's signature AND OAuth installation. This endpoint
 * verifies the separate Bridge bearer, worker identity and structured facts;
 * it does not run agent code or grant GitHub/Linear review authority.
 */
export function createEventIntelligenceIntakeRoute({
  jobsDir, env = process.env,
  intakeToken = env.EVENT_INTELLIGENCE_INTAKE_TOKEN,
  logger = console,
  persist = persistNoPromptIntake, bodyReader = readBody,
}) {
  return async function handleEventIntelligenceIntake(request, response, { url }) {
    if (url.pathname !== "/event-intelligence/intake") return false;
    if (request.method !== "POST") {
      response.setHeader?.("Allow", "POST");
      sendJson(response, 405, { ok: false, error: "Use POST" });
      return true;
    }
    if (env.EVENT_INTELLIGENCE_MODE !== "shadow") {
      sendJson(response, 503, { ok: false, error: "Intake not enabled" });
      return true;
    }
    if (typeof intakeToken !== "string" || intakeToken.length < 32) {
      sendJson(response, 503, { ok: false, error: "Intake credential not configured" });
      return true;
    }
    if (!sameSecret(request.headers.authorization, "Bearer " + intakeToken) ||
        request.headers["x-bridge-worker"] !== "linear-chatgpt-agent") {
      sendJson(response, 401, { ok: false, error: "Unauthorized" });
      return true;
    }
    let body;
    try {
      const raw = await bodyReader(request);
      if (Buffer.byteLength(raw) > 8192) throw Error("oversized");
      body = JSON.parse(raw);
    } catch {
      sendJson(response, 400, { ok: false, error: "Invalid intake payload" });
      return true;
    }
    if (!body || body.workerIdentity !== request.headers["x-bridge-worker"]) {
      sendJson(response, 400, { ok: false, error: "Invalid worker identity" });
      return true;
    }
    try {
      const saved = await persist(jobsDir, body);
      sendJson(response, 202, {
        ok: true, accepted: true, durable: true, duplicate: saved.duplicate,
        stage: saved.stage, deliveryHash: saved.deliveryHash,
        dispatchStatus: "not_started", reviewLaunchStatus: "not_started",
      });
    } catch (error) {
      const invalid = error.message === "Invalid signed no-prompt intake" ||
        error.message === "Unlinked verified issue";
      const collision = error.message === "Intake receipt collision or tampering";
      logger.warn?.("ABR-18 no-prompt intake rejected", {
        code: invalid ? "INVALID_EVENT" : collision ? "RECEIPT_COLLISION" :
          typeof error.code === "string" ? error.code : "PERSISTENCE_FAILURE",
      });
      sendJson(response, invalid ? 422 : collision ? 409 : 503, {
        ok: false, accepted: false, error: invalid ? "Invalid event metadata" :
          collision ? "Conflicting delivery" : "Durable intake unavailable",
      });
    }
    return true;
  };
}
