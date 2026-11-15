import {
  identifyLinearJobDelivery,
  linearJobDuplicateResponse,
} from "./job-admission.mjs";
import { preflightLinearJob } from "./job-preflight.mjs";
import {
  canRecoverUnroutedDelivery,
  handleUnroutedDelivery,
} from "./unrouted-delivery.mjs";

/**
 * Coordinate an already authenticated and parsed /jobs delivery.
 *
 * This must never send an HTTP response or start an agent. Its result is
 * either { response: { status, body } } or an admitted delivery whose route,
 * credentials and identity can be handed to the existing dispatch path.
 * Durable claim and duplicate handling deliberately remain after preflight.
 */
export async function coordinateJobAdmission({
  headers, rawBody, job, host, agent,
  sharedSecret, resolveJobRoute, syncLinearCredential, checkOpenCodeReady,
  jobStore, agentJobDirs,
  identifyDelivery = identifyLinearJobDelivery,
  preflight = preflightLinearJob,
  duplicateResponseFor = linearJobDuplicateResponse,
  recoverableUnrouted = canRecoverUnroutedDelivery,
  handleUnrouted = handleUnroutedDelivery,
}) {
  const { safeJobId, deliveryId, jobKey } = identifyDelivery({
    headers, rawBody, agent,
  });
  // Do not create a claim until routing, credential exchange and local CLI
  // readiness have completed. Failed preflight remains safely retryable.
  const { route, credential, rejection } = await preflight({
    job, agent, sharedSecret, resolveJobRoute,
    syncLinearCredential, checkOpenCodeReady,
  });
  if (rejection) return { response: rejection };

  const claimed = await jobStore.claim(jobKey, {
    agent, deliveryId: String(deliveryId), jobId: safeJobId,
  });
  // Only unlaunched "received" claims can finish an interrupted unrouted
  // task write. A launched or ambiguous agent is never replayed here.
  const recoveringUnrouted = recoverableUnrouted({ claimed, route, jobKey, agent });
  if (!recoveringUnrouted) {
    const duplicateResponse = duplicateResponseFor(claimed, safeJobId, host);
    if (duplicateResponse) return { response: duplicateResponse };
  }
  const unrouted = await handleUnrouted({
    agent, safeJobId, jobKey, job, route, agentJobDirs, jobStore,
  });
  if (unrouted) return { response: unrouted };

  return { delivery: { agent, safeJobId, deliveryId, jobKey, route, credential } };
}
