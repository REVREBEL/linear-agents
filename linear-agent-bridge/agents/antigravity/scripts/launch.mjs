// Antigravity execution adapter. The Python runner retains session callbacks,
// quota exhaustion events, and conversation ID continuity.
export function buildAntigravityLaunch({ pythonBin, runnerPath, sessionId, taskFile, conversationId, workspace, projectDir, credential, env = process.env }) {
  if (!pythonBin || !runnerPath || !sessionId || !taskFile || !workspace) throw Error("Incomplete Antigravity launch");
  const childEnv = { ...env, ANTIGRAVITY_WORKSPACE: workspace };
  delete childEnv.LINEAR_API_KEY;
  delete childEnv.LINEAR_ACCESS_TOKEN;
  if (credential) childEnv[credential.variable] = credential.accessToken;
  return {
    command: pythonBin,
    args: [runnerPath, sessionId, taskFile, ...(conversationId ? [conversationId] : [])],
    options: { cwd: projectDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  };
}
