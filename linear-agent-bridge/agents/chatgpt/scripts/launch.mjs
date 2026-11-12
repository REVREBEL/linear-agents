// Headless ChatGPT execution through the already-authenticated OpenCode CLI.
// No browser automation, ChatGPT cookies, or OpenAI API key required.
// Completion is controlled by the Ubuntu bridge, not by a prompt-side curl.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";

export async function checkOpenCodeReady({
  binary = process.env.OPENCODE_BIN || "",
  model = process.env.CHATGPT_OPENCODE_MODEL || "",
  runAsUser = process.env.CHATGPT_OPENCODE_USER || "",
  fsApi = fs,
}) {
  if (!binary || !binary.startsWith("/")) throw Error("Set OPENCODE_BIN to the absolute installed OpenCode CLI path");
  if (!model.startsWith("openai/")) {
    throw Error("Set CHATGPT_OPENCODE_MODEL to an authenticated openai/<model> (not local Ollama)");
  }
  if (runAsUser && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAsUser)) throw Error("Invalid CHATGPT_OPENCODE_USER");
  if (process.platform === "linux" && runAsUser) {
    throw Error("CHATGPT_OPENCODE_USER is unsupported on Linux; run OpenCode directly as the bridge service user");
  }
  await fsApi.access(runAsUser ? "/usr/bin/sudo" : binary, fs.constants.X_OK);
  return true;
}

export function buildOpenCodeLaunch({
  binary = process.env.OPENCODE_BIN || "opencode",
  model = process.env.CHATGPT_OPENCODE_MODEL || "",
  runAsUser = process.env.CHATGPT_OPENCODE_USER || "",
  workspace, prompt, sessionId = null,
  env = process.env,
}) {
  if (typeof workspace !== "string" || !workspace.startsWith("/") ||
      typeof prompt !== "string" || !prompt.trim()) throw Error("Invalid OpenCode workspace or prompt");
  if (!/^(?:opencode|\/[a-zA-Z0-9_.\/-]+)$/.test(binary) || binary.includes("..")) {
    throw Error("OPENCODE_BIN must be opencode or an absolute trusted executable");
  }
  if (model && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(model)) {
    throw Error("CHATGPT_OPENCODE_MODEL must be a provider/model identifier");
  }
  if (sessionId && !/^ses_[a-zA-Z0-9]+$/.test(sessionId)) throw Error("Invalid OpenCode session ID");
  const args = ["run", "--format", "json", ...(model ? ["--model", model] : []),
    ...(sessionId ? ["--session", sessionId] : []), prompt];
  const childEnv = { ...env };
  // The agent uses its own ChatGPT OAuth login; never pass bridge-wide
  // secrets or unrelated personal/Linear credentials into model tools.
  for (const key of ["BRIDGE_SHARED_SECRET", "LINEAR_API_KEY", "LINEAR_ACCESS_TOKEN",
    "CHATGPT_LINEAR_API_KEY", "CLOUDFLARE_API_TOKEN"]) delete childEnv[key];
  if (runAsUser && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAsUser)) throw Error("Invalid CHATGPT_OPENCODE_USER");
  if (process.platform === "linux" && runAsUser) {
    throw Error("CHATGPT_OPENCODE_USER is unsupported on Linux; configure OpenCode under the bridge account");
  }
  if (runAsUser && !binary.startsWith("/")) throw Error("OPENCODE_BIN must be absolute when using CHATGPT_OPENCODE_USER");
  return { command: runAsUser ? "/usr/bin/sudo" : binary,
    args: runAsUser ? ["-n", "-H", "-u", runAsUser, "--", binary, ...args] : args,
    options: {
    cwd: workspace, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  } };
}

export function parseOpenCodeEvent(line) {
  try {
    const event = JSON.parse(line);
    const sessionId = typeof event.sessionID === "string" ? event.sessionID : event.sessionId;
    // Do not log arbitrary tool inputs, content blocks, or account details.
    return {
      sessionId: /^ses_[a-zA-Z0-9]+$/.test(sessionId || "") ? sessionId : null,
      error: event.type === "error" ? "OpenCode reported an error" : null,
      type: typeof event.type === "string" ? event.type : null,
      summary: event.type === "text" && typeof event.part?.text === "string" ? event.part.text.slice(0, 3500) : null,
    };
  } catch { return null; }
}

// Only generic statuses leave the OpenCode process; never tool inputs.
export function summarizeOpenCodeProgress(type) {
  switch (type) {
    case "step_start": return "ChatGPT CLI is analyzing the coding task.";
    case "tool_use":
    case "tool_call": return "ChatGPT CLI is working in the repository.";
    case "step_finish": return "ChatGPT CLI completed an implementation step.";
    default: return null;
  }
}

export async function runOpenCode({
  launch, spawnImpl = spawn, onSession = async () => {},
  onProgress = () => {}, maxDurationMs = 30 * 60 * 1000,
}) {
  const child = spawnImpl(launch.command, launch.args, launch.options);
  let buffer = "", observedSession = null, reportedError = false, finalText = "";
  let progressChain = Promise.resolve(), lastProgressAt = 0, lastProgress = "";
  const sessionWrites = [];
  const timer = setTimeout(() => child.kill("SIGTERM"), maxDurationMs);
  child.stdout.on("data", chunk => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 2 * 1024 * 1024) buffer = buffer.slice(-1024 * 1024);
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const event = parseOpenCodeEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (!event) continue;
      if (event.error) reportedError = true;
      if (event.summary) finalText = event.summary;
      if (event.sessionId && event.sessionId !== observedSession) {
        observedSession = event.sessionId;
        sessionWrites.push(Promise.resolve().then(() => onSession(observedSession)));
      }
      const progress = summarizeOpenCodeProgress(event.type);
      if (progress && (progress !== lastProgress || Date.now() - lastProgressAt > 30000)) {
        lastProgress = progress;
        lastProgressAt = Date.now();
        progressChain = progressChain.then(() => onProgress(progress));
      }
    }
  });
  // Avoid dumping credentials, prompts or tool outputs from stderr into logs.
  child.stderr.on("data", () => {});
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code));
    });
    await Promise.all(sessionWrites);
    await progressChain;
    if (exitCode !== 0 || reportedError) throw Error("OpenCode execution failed (exit " + exitCode + ")");
    if (!finalText.trim()) throw Error("OpenCode emitted no final text; completion unverified");
    return { sessionId: observedSession, exitCode, summary: finalText };
  } finally {
    clearTimeout(timer);
  }
}
