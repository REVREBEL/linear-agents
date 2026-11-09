// Native Gemini CLI adapter. The bridge retains job state and process logs.
// Arg interpolation must be supplied by the existing shell-free template parser.
export function buildGeminiLaunch({ binary, template, prompt, taskFile, workspace, credential, buildArgs, env = process.env }) {
  if (!binary || !prompt || !taskFile || !workspace || typeof buildArgs !== "function") throw Error("Incomplete Gemini launch");
  const args = buildArgs(template, prompt, taskFile, workspace);
  const childEnv = { ...env, LINEAR_API_KEY: "", LINEAR_ACCESS_TOKEN: "" };
  if (credential) childEnv[credential.variable] = credential.accessToken;
  return { command: binary, args, options: {
    cwd: workspace, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  } };
}
