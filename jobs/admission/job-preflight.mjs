/**
 * Resolve job routing, synchronize agent credentials, and verify the
 * ChatGPT CLI runtime before the durable delivery claim is written.
 * Dependencies remain owned by the original bridge runtime.
 */
export async function preflightLinearJob({
  job, agent, sharedSecret, resolveJobRoute, syncLinearCredential,
  checkOpenCodeReady,
}) {
  // The sequence matters: a failed route, token synchronization, or runtime
  // readiness check must not create a partially accepted delivery claim.
  const route = await resolveJobRoute(job);
  const credential = route.ok ? await syncLinearCredential({
    agent,
    repositoryRoot: route.repositoryRoot,
    organizationId: job.organizationId,
    completionUrl: job.completionUrl || job.payload?.data?.completionUrl,
    sharedSecret,
    persist: route.executionHost !== "macos",
  }) : null;
  if (agent === "chatgpt-cli") {
    try {
      await checkOpenCodeReady();
    } catch (error) {
      return {
        route, credential,
        rejection: {
          status: 503,
          body: {
            ok: false, accepted: false,
            error: "OpenCode ChatGPT runtime not ready: " + error.message,
          },
        },
      };
    }
  }
  return { route, credential, rejection: null };
}
