import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./worker-process.mjs", import.meta.url));
export async function runGemmaIsolated({
  workspace, prompt, onStatus = async () => {},
  spawnImpl = spawn,
  nodeBin = process.env.GEMMA_NODE_BIN || "/usr/bin/node",
  user = "rebel",
}) {
  if (user !== "rebel" || !path.isAbsolute(nodeBin) || nodeBin.includes("..")) throw Error("Invalid Gemma runtime identity");
  if (typeof workspace !== "string" || !workspace.startsWith("/home/rebel/") || !prompt?.trim() || prompt.length > 12000) {
    throw Error("Invalid isolated Gemma task");
  }
  // sudoers must allow ONLY this absolute executable/script pair for the
  // dedicated account, with no password. Do not pass bridge environment.
  const child = spawnImpl("/usr/bin/sudo", ["-n", "-H", "-u", user, "--", nodeBin, script], {
    cwd: "/home/rebel",
    env: { PATH: "/usr/bin:/bin", HOME: "/home/rebel", USER: user, LOGNAME: user },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const messages = [];
  let buffer = "", total = 0, result = null;
  const timeout = setTimeout(() => child.kill("SIGTERM"), 6 * 60 * 1000);
  child.stdin.end(JSON.stringify({ workspace, prompt }));
  child.stdout.on("data", chunk => {
    total += chunk.length;
    if (total > 250000) { child.kill("SIGTERM"); return; }
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "done" && typeof event.text === "string") result = event.text;
      if (event.type === "status" && typeof event.message === "string")
        messages.push(Promise.resolve().then(() => onStatus(event.message)));
    }
  });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await Promise.all(messages);
    if (code !== 0 || !result) throw Error("Isolated Gemma runner failed; inspect its protected service logs");
    return { text: result };
  } finally { clearTimeout(timeout); }
}
