import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

// Load one provider credential under rebel, without persisting a key file.
// The bridge never receives the key or the other 1Password credentials.
const PROVIDER_VARIABLES = Object.freeze({
  openrouter: "OPENROUTER_API_KEY",
  litellm: "LITELLM_API_KEY",
});
const runFile = promisify(nodeExecFile);

export async function loadGemmaProviderKey(provider, {
  execFile = runFile,
  zsh = "/usr/bin/zsh",
} = {}) {
  const variable = PROVIDER_VARIABLES[provider];
  if (!variable) throw Error("Unsupported Gemma credential provider");

  // Noninteractive zsh reads /home/rebel/.zshenv automatically.
  // Provider variable names come exclusively from the fixed allowlist.
  const script = [
    "emulate -L zsh",
    "unsetopt xtrace verbose",
    "load_op_env >/dev/null 2>&1 || exit 71",
    '[[ -n "${' + variable + '}" ]] || exit 72',
    'print -rn -- "${' + variable + '}"',
  ].join("\n");

  const environment = {
    HOME: "/home/rebel",
    USER: "rebel",
    LOGNAME: "rebel",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  };
  let output;
  try {
    ({ stdout: output } = await execFile(zsh, ["-c", script], {
      env: environment,
      timeout: 30000,
      maxBuffer: 8192,
      encoding: "utf8",
    }));
  } catch {
    // Never propagate subprocess stdout/stderr: they may contain credentials.
    throw Error("Gemma provider credential could not be loaded from 1Password");
  }
  if (typeof output !== "string" || !output.trim() || output.length > 8192) {
    throw Error("Gemma provider credential unavailable");
  }
  return output.trim();
}
