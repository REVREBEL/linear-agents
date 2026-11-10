// Gemma proof-of-capability: read-only repository inventory with a bounded SDK agent loop.
// No shell, write, Git, SSH, Linear, or Cloudflare tools are exposed to the model.
import fs from "node:fs/promises";
import path from "node:path";
import { runOpenRouterAgent, loadOpenRouterAgentSdk } from "../../../integrations/openrouter/agent-runtime.mjs";

export const GEMMA_MODEL = "google/gemma-4-31b-it:free";
const DENIED = new Set([".git", ".env", ".dev.vars", ".secrets", "node_modules", ".linear-agent", "linear-jobs", ".ssh", ".config", "credentials", "private", "__pycache__"]);
const SECRET_NAME = /(?:^|[._-])(secret|credential|token|password|private.key|pem|p12|key)(?:$|[._-])/i;
function permittedRelative(value) {
  if (typeof value !== "string" || value.length > 260 || !value || value.includes("\\") || value.includes("\0") || path.isAbsolute(value)) throw Error("Invalid relative path");
  const parts = value.split("/");
  if (parts.some(part => !part || part === ".." || part === "." || part.startsWith(".") || DENIED.has(part) || SECRET_NAME.test(part))) {
    throw Error("Path is not permitted");
  }
  return value;
}
function within(root, target) {
  return target === root || target.startsWith(root + path.sep);
}
export async function makeReadOnlyInventoryTools(workspace, sdk, fsApi = fs) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) throw Error("Workspace must be absolute");
  const root = await fsApi.realpath(workspace);
  const { tool, z } = sdk;
  async function safeTarget(relative) {
    const candidate = path.resolve(root, permittedRelative(relative));
    if (!within(root, candidate)) throw Error("Outside workspace");
    const stat = await fsApi.lstat(candidate);
    if (stat.isSymbolicLink()) throw Error("Symlinks are not permitted");
    const real = await fsApi.realpath(candidate);
    if (!within(root, real)) throw Error("Outside workspace");
    // Resolve the canonical path again to block hidden directories reached through a symlink.
    permittedRelative(path.relative(root, real));
    return { real, stat };
  }
  const listDirectory = tool({
    name: "list_directory",
    description: "List names in an approved directory. Use a repository-relative directory path, or root for the repository root. This cannot list secret/hidden directories.",
    inputSchema: z.object({ directory: z.string() }),
    execute: async ({ directory }) => {
      const target = directory === "root" ? root : (await safeTarget(directory)).real;
      const entries = await fsApi.readdir(target, { withFileTypes: true });
      return entries.filter(entry => !entry.name.startsWith(".") && !DENIED.has(entry.name) && !SECRET_NAME.test(entry.name) && !entry.isSymbolicLink()).slice(0, 150)
        .map(entry => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" }));
    },
  });
  const readFile = tool({
    name: "read_file",
    description: "Read a bounded source or documentation file by repository-relative path. Never read secrets or hidden files.",
    inputSchema: z.object({ file: z.string() }),
    execute: async ({ file }) => {
      const { real, stat } = await safeTarget(file);
      if (!stat.isFile() || stat.size > 32768) throw Error("File is missing, not regular, or too large");
      const content = await fsApi.readFile(real, "utf8");
      if (content.includes("\0")) throw Error("Binary file is not permitted");
      return content.slice(0, 32768);
    },
  });
  return [listDirectory, readFile];
}

export async function runGemmaInventory({
  workspace, prompt, apiKey, sdk = null, onStatus = async () => {},
}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw Error("Prompt required");
  const runtime = sdk ?? await loadOpenRouterAgentSdk();
  const tools = await makeReadOnlyInventoryTools(workspace, runtime);
  return runOpenRouterAgent({
    apiKey, model: GEMMA_MODEL, input: prompt, sdk: runtime, tools,
    maxSteps: 8, onStatus,
    instructions: [
      "You are an isolated, read-only architecture evaluation agent.",
      "Inspect only the approved repository using your provided tools.",
      "Do not request secrets, credentials, hidden paths, filesystem writes, shell commands, or external network access.",
      "Return a concise inventory, old-to-new migration mapping, test gates, risks, and rollback plan.",
      "Do not claim you changed a file, ran tests, created a PR, or deployed code.",
    ].join(" "),
  });
}
