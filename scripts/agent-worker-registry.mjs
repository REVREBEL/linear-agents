// Current physical Worker locations are read from the canonical registry.
// This is a static build-time adapter, not authorization for runtime agent execution.
import { readFileSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = file => JSON.parse(readFileSync(file,"utf8"));

export function getWorkerRegistry(root = REPO_ROOT) {
  const data = readJson(path.join(root,"agents/registry.json"));
  if (data.schemaVersion !== 2 || !Array.isArray(data.agents))
    throw new Error("Unsupported agent registry version");
  const registry = new Map();
  for (const entry of data.agents) {
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9-]+$/.test(entry.id) ||
        registry.has(entry.id))
      throw new Error("Invalid or duplicate agent registry identity");
    if (!entry.worker || typeof entry.worker.directory !== "string" ||
        !/^[a-zA-Z0-9._/-]+$/.test(entry.worker.directory) ||
        entry.worker.directory.startsWith("/") ||
        entry.worker.directory.split("/").includes(".."))
      throw new Error("Invalid registry Worker directory for " + entry.id);
    const canonicalRoot = realpathSync(root);
    const folder = path.resolve(canonicalRoot,entry.worker.directory);
    if (!folder.startsWith(canonicalRoot + path.sep) ||
        !existsSync(folder) || !realpathSync(folder).startsWith(canonicalRoot + path.sep) ||
        !existsSync(path.join(folder,"wrangler.jsonc")))
      throw new Error("Missing or unsafe Worker directory for " + entry.id);
    registry.set(entry.id,{...entry,workerDir:folder});
  }
  return registry;
}

export function requireWorker(id, root = REPO_ROOT) {
  const entry = getWorkerRegistry(root).get(id);
  if (!entry) throw new Error("Unknown registered Worker: " + id);
  return entry;
}
