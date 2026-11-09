import path from "node:path";

// Linear's group is currently named agent-location. The GitHub canonical
// label is agent-location:mac, while the existing Linear child is "Macos".
const MAC_NAMES = new Set(["mac", "macos", "agent-location:mac"]);
const SERVER_NAMES = new Set(["bridge-server", "bridge server", "agent-location:bridge-server"]);

export function chooseExecutionHost(routing) {
  const label = routing?.agentLocation;
  if (label == null || label === "") return { ok: true, host: "bridge-server", source: "default" };
  if (typeof label !== "string") return { ok: false, error: "Invalid Agent Location label" };
  const normalized = label.trim().toLowerCase();
  if (MAC_NAMES.has(normalized)) return { ok: true, host: "macos", source: "linear-label" };
  if (SERVER_NAMES.has(normalized)) return { ok: true, host: "bridge-server", source: "linear-label" };
  return { ok: false, error: "Unrecognized Agent Location: " + label };
}

export function configuredProjectRoots(env = process.env) {
  const linux = env.LINUX_PROJECTS_ROOT || env.PROJECTS_ROOT;
  const mac = env.OSX_PROJECTS_ROOT;
  return { linux, mac };
}

export function makeRemoteRoute({ root, repository, scope = ".", launchFromScope = false }) {
  if (typeof root !== "string" || !path.posix.isAbsolute(root) ||
      root === "/" || root.includes("\n") || root.includes("\0")) {
    throw Error("OSX_PROJECTS_ROOT must be an absolute macOS path");
  }
  if (!/^REVREBEL\/[a-zA-Z0-9._-]+$/.test(repository)) throw Error("Invalid approved repository");
  if (typeof scope !== "string" || path.posix.isAbsolute(scope) || scope.includes("\0")) {
    throw Error("Invalid relative project scope");
  }
  const repositoryRoot = path.posix.resolve(root, repository.split("/")[1]);
  const scopePath = path.posix.resolve(repositoryRoot, scope);
  if (scopePath !== repositoryRoot && !scopePath.startsWith(repositoryRoot + "/")) {
    throw Error("Project scope escapes remote repository");
  }
  return { repositoryRoot, projectScope: scope, launchDirectory: launchFromScope ? scopePath : repositoryRoot };
}

export function validateSshSettings(env = process.env) {
  const host = env.MAC_SSH_HOST;
  if (!host || !/^[a-zA-Z0-9_.@-]+$/.test(host) || host.startsWith("-")) {
    throw Error("MAC_SSH_HOST must name a trusted SSH host or alias");
  }
  const nodeBin = env.MAC_NODE_BIN || "node";
  if (!/^(?:node|\/[a-zA-Z0-9_./-]+)$/.test(nodeBin) || nodeBin.includes("..")) {
    throw Error("MAC_NODE_BIN must be node or an absolute trusted executable");
  }
  const roots = configuredProjectRoots(env);
  const runner = env.MAC_RUNNER_PATH || path.posix.join(roots.mac || "", "linear-agents", "linear-agent-bridge/agents/trae/scripts/launch.mjs");
  if (!path.posix.isAbsolute(runner) || runner.includes("\n") || runner.includes("\0") || runner.includes("'")) {
    throw Error("MAC_RUNNER_PATH must be an absolute trusted macOS file path");
  }
  return { host, nodeBin, runner };
}
