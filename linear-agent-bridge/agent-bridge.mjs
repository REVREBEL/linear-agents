import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createJobStore } from "./job-store.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 8788);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";

const SHARED_SECRET = process.env.BRIDGE_SHARED_SECRET || "";
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || "";
const LINEAR_ACCESS_TOKEN = process.env.LINEAR_ACCESS_TOKEN || "";

const PROJECT_DIR = path.dirname(new URL(import.meta.url).pathname);
const AGENT_ENV_FILE = process.env.AGENT_ENV_FILE || path.join(PROJECT_DIR, ".env");
const PROJECTS_ROOT =
  process.env.PROJECTS_ROOT || path.join(os.homedir(), "github-revrebel");
const JOBS_DIR = path.join(PROJECT_DIR, "linear-jobs");
const jobStore = createJobStore(JOBS_DIR);
const ROUTING_CONFIG_FILE = process.env.ROUTING_CONFIG_FILE || path.join(PROJECT_DIR, "routing.json");
const AGENT_JOB_DIRS = {
  antigravity: path.join(JOBS_DIR, "antigravity"),
  mock: path.join(JOBS_DIR, "mock"),
  chatgpt: path.join(JOBS_DIR, "chatgpt"),
  trae: path.join(JOBS_DIR, "trae"),
  gemini: path.join(JOBS_DIR, "gemini"),
  unknown: path.join(JOBS_DIR, "unknown"),
};

const PYTHON_BIN =
  process.env.PYTHON_BIN || path.join(PROJECT_DIR, ".venv", "bin", "python");
const RUN_AGENT_PATH =
  process.env.RUN_AGENT_PATH || path.join(PROJECT_DIR, "run_agent.py");

// Public hostnames that Cloudflare Tunnel forwards to this same local listener.
const ANTIGRAVITY_HOST =
  process.env.ANTIGRAVITY_HOST || "antigravity-agent.revrebel.io";
const MOCK_HOST = process.env.MOCK_HOST || "mock-agent.revrebel.io";
const CHATGPT_HOST =
  process.env.CHATGPT_HOST || "chatgpt-agent.revrebel.io";
const TRAE_HOST =
  process.env.TRAE_HOST || "trae-agent.revrebel.io";
const GEMINI_HOST =
  process.env.GEMINI_HOST || "gemini-agent.revrebel.io";

// Legacy agent workspace overrides referred to an older checkout location.
// All actual jobs now launch from resolveJobRoute(), using routing.json.
// Report the running bridge directory here, not stale workspace variables.
const AGENT_WORKSPACE = PROJECT_DIR;
const ANTIGRAVITY_WORKSPACE = PROJECT_DIR;
const CHATGPT_WORKSPACE = PROJECT_DIR;

const TRAE_BIN = process.env.TRAE_BIN || "";
const TRAE_WORKSPACE = PROJECT_DIR;
const TRAE_ARGS_TEMPLATE =
  process.env.TRAE_ARGS_TEMPLATE || "chat --reuse-window --maximize {{PROMPT}}";

const GEMINI_BIN = process.env.GEMINI_BIN || "";
const GEMINI_WORKSPACE = PROJECT_DIR;
const GEMINI_LAUNCH_MODE = process.env.GEMINI_LAUNCH_MODE || "headless";
const GEMINI_ARGS_TEMPLATE =
  process.env.GEMINI_ARGS_TEMPLATE ||
  "-p {{PROMPT}} --approval-mode auto_edit --skip-trust";

if (!SHARED_SECRET) {
  console.error("Missing BRIDGE_SHARED_SECRET environment variable.");
  process.exit(1);
}

await Promise.all(
  Object.values(AGENT_JOB_DIRS).map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ),
);

const recovered = await jobStore.reconcile();
if (recovered) console.warn(`Marked ${recovered} unfinished jobs interrupted; manual reconciliation required.`);

const server = http.createServer(async (request, response) => {
  try {
    const host = normalizeHost(request.headers.host);
    const url = new URL(request.url || "/", `http://${host || "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        ok: true,
        service: "local-linear-agent-router",
        host,
        port: PORT,
        antigravityHost: ANTIGRAVITY_HOST,
        chatgptHost: CHATGPT_HOST,
        mockHost: MOCK_HOST,
        traeHost: TRAE_HOST,
        geminiHost: GEMINI_HOST,
        python: PYTHON_BIN,
        antigravityWorkspace: ANTIGRAVITY_WORKSPACE,
        chatgptWorkspace: CHATGPT_WORKSPACE,
        traeBin: TRAE_BIN || null,
        traeWorkspace: TRAE_WORKSPACE,
        geminiBin: GEMINI_BIN || null,
        geminiWorkspace: GEMINI_WORKSPACE,
        projectsRoot: PROJECTS_ROOT,
        jobsDir: JOBS_DIR,
        hasBridgeSharedSecret: Boolean(SHARED_SECRET),
        hasLinearApiKey: Boolean(LINEAR_API_KEY),
        hasLinearAccessToken: Boolean(LINEAR_ACCESS_TOKEN),
      });
    }

    if (request.method !== "POST" || url.pathname !== "/jobs") {
      return sendJson(response, 404, {
        ok: false,
        error: "Not found",
        host,
        path: url.pathname,
      });
    }

    if (request.headers.authorization !== `Bearer ${SHARED_SECRET}`) {
      return sendJson(response, 401, { ok: false, error: "Unauthorized" });
    }

    const rawBody = await readBody(request);
    const job = JSON.parse(rawBody);

    const jobId =
      request.headers["x-linear-webhook-id"] ??
      `job-${Date.now()}-${crypto.randomUUID()}`;
    const safeJobId = String(jobId).replace(/[^a-zA-Z0-9._-]/g, "_");
    const agent = agentForHost(host);
    // Scope delivery identifiers by agent and preserve their original contents.
    // For missing upstream IDs, hash the payload so retries stay idempotent.
    const deliveryId = request.headers["x-linear-webhook-id"] ??
      crypto.createHash("sha256").update(rawBody).digest("hex");
    const jobKey = `${agent}:${String(deliveryId)}`;
    const claimed = await jobStore.claim(jobKey, { agent, deliveryId: String(deliveryId), jobId: safeJobId });
    if (!claimed.created) {
      return sendJson(response, 202, {
        ok: true, accepted: true, duplicate: true, jobId: claimed.record?.jobId || safeJobId,
        state: claimed.record?.state || "claimed", host,
      });
    }
    const route = await resolveJobRoute(job);
    if (!route.ok) {
      const pendingFile = path.join(AGENT_JOB_DIRS[agent], `${safeJobId}.unrouted.json`);
      await fs.writeFile(pendingFile, JSON.stringify({ reason: route.error, job }, null, 2), { mode: 0o600 });
      await jobStore.transition(jobKey, "unrouted", { error: route.error, taskFile: pendingFile });
      console.error(`Routing failed: ${route.error}; saved pending job to ${pendingFile}`);
      return sendJson(response, 422, { ok: false, accepted: false, error: route.error });
    }

    const workspace = route.launchDirectory;
    const taskDir = path.join(route.repositoryRoot, ".linear-agent", "projects", route.scopeKey, "inbox");
    await fs.mkdir(taskDir, { recursive: true, mode: 0o700 });
    // Keep runtime task payloads local without modifying the repository's tracked .gitignore.
    const localExclude = path.join(route.repositoryRoot, ".git", "info", "exclude");
    try {
      const existingExclude = await fs.readFile(localExclude, "utf8");
      if (!existingExclude.split(/\r?\n/).includes("/.linear-agent/")) {
        await fs.appendFile(localExclude, "\n/.linear-agent/\n");
      }
    } catch (error) {
      console.warn(`Unable to set local Git exclusion for task directory: ${error.message}`);
    }
    const filename = path.join(taskDir, `${safeJobId}.json`);
    const directTask = extractDirectTask(extractPromptContext(job));
    // Persist and dispatch one canonical prompt. The raw Linear webhook embeds
    // the same issue in agentSession.issue and promptContext; keeping it
    // duplicates instructions and unnecessarily expands downstream context.
    const routedJob = {
      routing: job.routing,
      issueMetadata: job.issueMetadata,
      source: job.source,
      sessionAction: job.sessionAction || "created",
      receivedAt: job.receivedAt,
      organizationId: job.organizationId,
      agentSessionId: job.agentSessionId,
      completionUrl: job.completionUrl,
      payload: {
        data: {
          promptContext: directTask,
          agentSessionId: job.agentSessionId ?? job.payload?.data?.agentSessionId,
          completionUrl: job.completionUrl ?? job.payload?.data?.completionUrl,
        },
      },
    };
    await fs.writeFile(filename, JSON.stringify({
      ...routedJob,
      resolvedRouting: {
        repositoryRoot: route.repositoryRoot,
        projectScope: route.projectScope,
        launchDirectory: route.launchDirectory,
        linearProjectId: route.projectId,
        linearInitiativeId: route.initiativeId,
        chatgptProjectUrl: route.chatgptProjectUrl || null,
        chatgptConversationMode: route.chatgptConversationMode || null,
        chatgptAutoSend: route.chatgptAutoSend === true,
      },
    }, null, 2), { mode: 0o600 });

    await jobStore.transition(jobKey, "queued", { taskFile: filename, repositoryRoot: route.repositoryRoot, workspace });
    console.log("\nLinear job received");
    console.log(`Host: ${host}`);
    console.log(`Saved to: ${filename}`);
    console.log(`Resolved workspace: ${workspace}`);
    console.log(`Project scope: ${route.projectScope}`);

    await jobStore.transition(jobKey, "launching", { attempts: 1 });
    if (agent === "mock") {
      await jobStore.transition(jobKey, "awaiting_external", { note: "Mock Agent queued; use mock-agent CLI to advance status or comment", taskFile: filename });
      console.log(`Mock Agent queued: ${filename}`);
    } else if (agent === "antigravity") {
      startAntigravity(routedJob, filename, workspace, jobKey);
    } else if (agent === "chatgpt") {
      if (!route.chatgptProjectUrl) {
        await jobStore.transition(jobKey, "failed", { error: "No chatgpt.projectUrl in Linear project mapping" });
        console.error("ChatGPT handoff stopped: project mapping has no chatgpt.projectUrl");
      } else if (process.env.CHATGPT_HANDOFF_MODE === "supervised-playwright" || route.chatgptAutoSend === true) {
        const promptContext = extractPromptContext(routedJob);
        if (!promptContext) {
          await jobStore.transition(jobKey, "failed", { error: "Missing ChatGPT promptContext" });
        } else {
          const script = path.resolve(PROJECT_DIR, "../scripts/chatgpt-playwright/handoff-test.mjs");
          // This supervised test requires an attached terminal, and must not consume the daemon stdin.
          // Queue a ready-to-run handoff command as a local file instead of launching UI automation from launchd.
          const handoffFile = filename + ".chatgpt-handoff.json";
          await fs.writeFile(handoffFile, JSON.stringify({ projectUrl: route.chatgptProjectUrl, conversationMode: route.chatgptConversationMode, autoSend: route.chatgptAutoSend === true, prompt: promptContext, jobFile: filename }, null, 2), { mode: 0o600 });
          if (route.chatgptAutoSend === true) {
            await jobStore.transition(jobKey, "awaiting_external", { handoffFile, note: "Automatic Playwright submission launched; response processing not implemented" });
            const child = spawn(process.execPath, [script, "--handoff-file", handoffFile, "--auto-send"], {
              cwd: path.resolve(PROJECT_DIR, ".."), env: process.env, stdio: ["ignore", "pipe", "pipe"],
            });
            child.stdout?.on("data", chunk => console.log("[ChatGPT handoff] " + String(chunk).trimEnd()));
            child.stderr?.on("data", chunk => console.error("[ChatGPT handoff] " + String(chunk).trimEnd()));
            child.on("error", error => console.error("Automatic ChatGPT browser could not start:", error));
            child.on("exit", code => console.log("Automatic ChatGPT handoff exited:", code));
          } else {
            await jobStore.transition(jobKey, "awaiting_external", { handoffFile, note: "Supervised Playwright handoff ready; run manually" });
            console.log(`ChatGPT Playwright handoff ready: ${handoffFile}`);
            console.log(`Run: node ${script} --handoff-file ${handoffFile}`);
          }
        }
      } else {
        await jobStore.transition(jobKey, "awaiting_external", { note: "ChatGPT task saved; set CHATGPT_HANDOFF_MODE=supervised-playwright to prepare browser handoff" });
      }
    } else if (agent === "trae") {
      startTrae(routedJob, filename, workspace, jobKey);
    } else if (agent === "gemini") {
      await startGemini(routedJob, filename, workspace, jobKey);
    } else {
      await jobStore.transition(jobKey, "failed", { error: "Unknown agent host" });
      console.log(`Unknown agent hostname: ${host}. Job saved but not executed.`);
    }

    return sendJson(response, 202, {
      ok: true,
      accepted: true,
      jobId: safeJobId,
      host,
    });
  } catch (error) {
    console.error("Server Router Error:", error);
    return sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unexpected error",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Local Linear agent router listening on http://${HOST}:${PORT}`);
  console.log(`Antigravity host: ${ANTIGRAVITY_HOST}`);
  console.log(`ChatGPT host: ${CHATGPT_HOST}`);
  console.log(`Mock host: ${MOCK_HOST}`);
  console.log(`Trae host: ${TRAE_HOST}`);
  console.log(`Gemini host: ${GEMINI_HOST}`);
  console.log(`Antigravity workspace: ${ANTIGRAVITY_WORKSPACE}`);
  console.log(`ChatGPT workspace: ${CHATGPT_WORKSPACE}`);
  console.log(`Trae runner: ${TRAE_BIN || "not configured"}`);
  console.log(`Trae workspace: ${TRAE_WORKSPACE}`);
  console.log(`Gemini runner: ${GEMINI_BIN || "not configured"}`);
  console.log(`Gemini workspace: ${GEMINI_WORKSPACE}`);
  console.log(`Projects root: ${PROJECTS_ROOT}`);
  console.log(`Jobs directory: ${JOBS_DIR}`);
  console.log(`Python runner: ${PYTHON_BIN}`);
});

function startAntigravity(job, filename, workspace, jobKey) {
  const sessionId = extractAgentSessionId(job);

  if (!sessionId) {
    void jobStore.transition(jobKey, "failed", { error: "Missing Linear agent session ID" }).catch(console.error);
    console.log("Antigravity skipped. Missing Linear agent session ID.");
    return;
  }

  console.log(`Antigravity Agent Session verified (${sessionId}). Spawning local engine...`);

  const agentProcess = spawn(
    PYTHON_BIN,
    [RUN_AGENT_PATH, sessionId, filename],
    {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        ANTIGRAVITY_WORKSPACE: workspace,
        LINEAR_API_KEY,
        LINEAR_ACCESS_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  attachProcessLogs(agentProcess, "Antigravity", jobKey);
}

function startChatGPT(job, filename) {
  const sessionId = extractAgentSessionId(job);

  if (!sessionId) {
    console.log("ChatGPT skipped. Missing Linear agent session ID.");
    return;
  }

  // ChatGPT does not have a local executable here. The Worker has already saved
  // the Linear job to disk via this bridge. Gary/ChatGPT can inspect the saved
  // JSON file and call /complete from the task instructions when finished.
  console.log(`ChatGPT Agent Session verified (${sessionId}). Job saved only.`);
  console.log(`ChatGPT job file: ${filename}`);
}

function startTrae(job, filename, workspace, jobKey) {
  if (!TRAE_BIN) {
    void jobStore.transition(jobKey, "failed", { error: "TRAE_BIN not configured" }).catch(console.error);
    console.error("TRAE_BIN is not configured. Job saved but Trae was not started.");
    return;
  }

  const promptContext = extractPromptContext(job);
  if (!promptContext) {
    void jobStore.transition(jobKey, "failed", { error: "Missing Trae promptContext" }).catch(console.error);
    console.error("Trae skipped. No promptContext found.");
    return;
  }

  const args = buildGenericArgs(
    TRAE_ARGS_TEMPLATE,
    promptContext,
    filename,
    workspace,
  );

  console.log("Trae job accepted. Spawning Trae...");
  console.log(`Trae binary: ${TRAE_BIN}`);
  console.log(`Trae workspace: ${workspace}`);
  console.log(`Trae args: ${args.map(maskArg).join(" ")}`);
  console.log("Trae prompt transport: positional chat prompt");

  const traeProcess = spawn(TRAE_BIN, args, {
    cwd: workspace,
    env: {
      ...process.env,
      LINEAR_API_KEY,
      LINEAR_ACCESS_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  attachProcessLogs(traeProcess, "Trae", jobKey);
}

async function startGemini(job, filename, workspace, jobKey) {
  if (!GEMINI_BIN) {
    await jobStore.transition(jobKey, "failed", { error: "GEMINI_BIN not configured" });
    console.error("GEMINI_BIN is not configured. Job saved but Gemini was not started.");
    return;
  }

  const promptContext = extractPromptContext(job);
  if (!promptContext) {
    await jobStore.transition(jobKey, "failed", { error: "Missing Gemini promptContext" });
    console.error("Gemini skipped. No promptContext found.");
    return;
  }

  if (GEMINI_LAUNCH_MODE === "warp") {
    await startGeminiInWarp(promptContext, filename, workspace, jobKey);
    return;
  }

  const args = buildGenericArgs(
    GEMINI_ARGS_TEMPLATE,
    promptContext,
    filename,
    workspace,
  );

  console.log("Gemini job accepted. Spawning Gemini CLI...");
  console.log(`Gemini binary: ${GEMINI_BIN}`);
  console.log(`Gemini workspace: ${workspace}`);
  console.log(`Gemini args: ${args.map(maskArg).join(" ")}`);

  const geminiProcess = spawn(GEMINI_BIN, args, {
    cwd: workspace,
    env: {
      ...process.env,
      LINEAR_API_KEY,
      LINEAR_ACCESS_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  attachProcessLogs(geminiProcess, "Gemini", jobKey);
}

async function startGeminiInWarp(promptContext, filename, workspace, jobKey) {
  const jobStem = path.basename(filename, path.extname(filename));
  const launchDir = path.join(AGENT_JOB_DIRS.gemini, "warp-launchers");
  const tabConfigDir = path.join(os.homedir(), ".warp", "tab_configs");
  const promptFile = path.join(launchDir, `${jobStem}.prompt.txt`);
  const commandFile = path.join(launchDir, `${jobStem}.command`);
  const tabConfigStem = `linear_gemini_${jobStem}`;
  const tabConfigFile = path.join(tabConfigDir, `${tabConfigStem}.toml`);

  await Promise.all([
    fs.mkdir(launchDir, { recursive: true }),
    fs.mkdir(tabConfigDir, { recursive: true }),
  ]);
  await fs.writeFile(promptFile, promptContext, { encoding: "utf8", mode: 0o600 });

  const command = `#!/bin/zsh
set -e
export PATH=${shellQuote(process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin")}
export GOOGLE_CLOUD_PROJECT=${shellQuote(process.env.GOOGLE_CLOUD_PROJECT || "")}
cd ${shellQuote(workspace)}
if [[ ! -p ${shellQuote(AGENT_ENV_FILE)} ]]; then
  print -u2 -- "Gemini launch stopped: 1Password environment mount is unavailable at ${AGENT_ENV_FILE}"
  exit 1
fi
export BRIDGE_SHARED_SECRET="$(
  source ${shellQuote(AGENT_ENV_FILE)}
  print -rn -- "\${BRIDGE_SHARED_SECRET:-}"
)"
if [[ -z \${BRIDGE_SHARED_SECRET:-} ]]; then
  print -u2 -- "Gemini launch stopped: BRIDGE_SHARED_SECRET is missing from the mounted environment"
  exit 1
fi
# Warp starts a fresh interactive shell rather than inheriting launchd's environment.
# Load the LINEAR_API_KEY from the trusted repo-level environment file, not
# from a prompt, CLI argument, or persisted issue payload.
linear_env_file=${shellQuote(AGENT_ENV_FILE)}
if [[ ! -f "$linear_env_file" ]]; then
  print -u2 -- "Gemini launch stopped: bridge environment file not found"
  exit 1
fi
export LINEAR_API_KEY="$(
  source "$linear_env_file"
  print -rn -- "\${LINEAR_API_KEY:-}"
)"
if [[ -z ${LINEAR_API_KEY} ]]; then
  print -u2 -- "Gemini launch stopped: LINEAR_API_KEY not set in bridge environment"
  exit 1
fi
gemini_prompt=$(<${shellQuote(promptFile)})
exec ${shellQuote(GEMINI_BIN)} --prompt-interactive "$gemini_prompt" --approval-mode auto_edit --skip-trust
`;

  await fs.writeFile(commandFile, command, { encoding: "utf8", mode: 0o700 });

  const tabConfig = `name = ${JSON.stringify(`Linear Gemini ${jobStem}`)}
title = ${JSON.stringify(`Gemini: ${jobStem}`)}
color = "blue"

[[panes]]
id = "gemini"
type = "terminal"
shell = "zsh"
directory = ${JSON.stringify(workspace)}
commands = [${JSON.stringify(commandFile)}]
is_focused = true
`;

  await fs.writeFile(tabConfigFile, tabConfig, { encoding: "utf8", mode: 0o600 });
  const warpUri = `warp://tab_config/${encodeURIComponent(tabConfigStem)}?new_window=true`;

  console.log("Gemini job accepted. Opening interactive Gemini CLI in Warp...");
  console.log(`Gemini binary: ${GEMINI_BIN}`);
  console.log(`Gemini workspace: ${workspace}`);
  console.log(`Gemini Warp launcher: ${commandFile}`);
  console.log(`Gemini Warp tab config: ${tabConfigFile}`);

  const warpProcess = spawn("/usr/bin/open", [warpUri], {
    cwd: workspace,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  attachProcessLogs(warpProcess, "Gemini-Warp", jobKey, true);
}

function configuredWorkspaceForAgent(agent) {
  if (agent === "antigravity") return ANTIGRAVITY_WORKSPACE;
  if (agent === "chatgpt") return CHATGPT_WORKSPACE;
  if (agent === "trae") return TRAE_WORKSPACE;
  if (agent === "gemini") return GEMINI_WORKSPACE;
  return AGENT_WORKSPACE;
}

async function resolveJobRoute(job) {
  let config;
  try {
    config = JSON.parse(await fs.readFile(ROUTING_CONFIG_FILE, "utf8"));
  } catch (error) {
    return { ok: false, error: `Cannot load routing config ${ROUTING_CONFIG_FILE}: ${error.message}` };
  }
  const routing = job?.routing || {};
  const projectId = routing.projectId;
  const initiativeIds = Array.isArray(routing.initiativeIds) ? routing.initiativeIds : [];
  if (!projectId) {
    return { ok: false, error: "Missing structured Linear project ID; no implicit fallback" };
  }
  const project = config.projects?.[projectId];
  if (!project) return { ok: false, error: `Unmapped Linear project: ${projectId}` };
  const matches = initiativeIds.filter(id => config.initiatives?.[id] && (!project.initiativeId || project.initiativeId === id));
  let initiativeId = null;
  let repoName;
  if (project.repository) {
    // Standalone projects must explicitly declare their repository. If an
    // initiative is also configured, refuse a conflicting repository mapping.
    if (project.initiativeId && !initiativeIds.includes(project.initiativeId)) {
      return { ok: false, error: `Required initiative missing for project ${projectId}` };
    }
    if (matches.length > 1) {
      return { ok: false, error: `Ambiguous initiatives for project ${projectId}` };
    }
    initiativeId = matches[0] || null;
    if (initiativeId && config.initiatives[initiativeId].repository !== project.repository) {
      return { ok: false, error: `Conflicting repository mapping for project ${projectId}` };
    }
    repoName = project.repository;
  } else {
    if (matches.length !== 1) {
      return { ok: false, error: `Expected one mapped initiative for project ${projectId}, found ${matches.length}; set project.repository for a standalone project` };
    }
    initiativeId = matches[0];
    repoName = config.initiatives[initiativeId].repository;
  }
  if (typeof repoName !== "string" || !/^REVREBEL\/[a-zA-Z0-9._-]+$/.test(repoName)) {
    return { ok: false, error: "Invalid or missing allowed REVREBEL repository mapping" };
  }
  const root = path.resolve(config.projectsRoot || PROJECTS_ROOT);
  const target = path.resolve(root, repoName.split("/")[1]);
  let repositoryRoot;
  try {
    const realRoot = await fs.realpath(root);
    repositoryRoot = await fs.realpath(target);
    if (!repositoryRoot.startsWith(realRoot + path.sep) || !(await fs.stat(path.join(repositoryRoot, ".git"))).isDirectory()) {
      return { ok: false, error: "Repository escapes projects root or is not a Git checkout" };
    }
  } catch (error) {
    return { ok: false, error: `Repository not available: ${target}: ${error.message}` };
  }
  const projectScope = project.scope || ".";
  if (typeof projectScope !== "string" || path.isAbsolute(projectScope)) {
    return { ok: false, error: "Invalid project scope" };
  }
  const scoped = path.resolve(repositoryRoot, projectScope);
  let actualScope;
  try {
    actualScope = await fs.realpath(scoped);
    if (actualScope !== repositoryRoot && !actualScope.startsWith(repositoryRoot + path.sep)) {
      return { ok: false, error: "Project scope escapes repository root" };
    }
    if (!(await fs.stat(actualScope)).isDirectory()) throw new Error("Not a directory");
  } catch (error) {
    return { ok: false, error: `Project scope does not exist: ${scoped}: ${error.message}` };
  }
  const launchDirectory = project.launchFromScope === true ? actualScope : repositoryRoot;
  const scopeKey = String(projectId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const chatgptProjectUrl = project.chatgpt?.projectUrl;
  const chatgptConversationMode = project.chatgpt?.conversationMode || "new-per-issue";
  const chatgptAutoSend = project.chatgpt?.autoSend === true;
  if (project.chatgpt?.autoSend !== undefined && typeof project.chatgpt.autoSend !== "boolean") return { ok: false, error: "chatgpt.autoSend must be boolean" };
  if (chatgptAutoSend && chatgptConversationMode !== "reuse-existing") return { ok: false, error: "chatgpt.autoSend requires reuse-existing conversation mode" };
  if (chatgptProjectUrl !== undefined) {
    try {
      const destination = new URL(chatgptProjectUrl);
      const segments = destination.pathname.split("/").filter(Boolean);
      const isProjectPath = segments.length === 2 &&
        segments[0] === "g" && segments[1].startsWith("g-p-");
      const isConversationPath = segments.length === 4 &&
        segments[0] === "g" && segments[1].startsWith("g-p-") &&
        segments[2] === "c" && Boolean(segments[3]);
      const validPath = chatgptConversationMode === "reuse-existing"
        ? isConversationPath
        : chatgptConversationMode === "new-per-issue" && isProjectPath;
      if (destination.protocol !== "https:" || destination.hostname !== "chatgpt.com" ||
          destination.search || destination.hash || !validPath) {
        return { ok: false, error: `Invalid chatgpt.projectUrl or conversationMode for Linear project ${projectId}` };
      }
    } catch {
      return { ok: false, error: `Invalid chatgpt.projectUrl for Linear project ${projectId}` };
    }
  }
  return { ok: true, repositoryRoot, projectScope, launchDirectory, scopeKey, projectId, initiativeId, chatgptProjectUrl, chatgptConversationMode, chatgptAutoSend };
}

function extractAgentSessionId(job) {
  const original = job?.payload?.original ?? {};

  return firstString([
    job?.agentSessionId,
    job?.payload?.data?.agentSessionId,
    original?.data?.id,
    original?.agentSession?.id,
    original?.data?.agentSession?.id,
    original?.agentSessionId,
    original?.data?.agentSessionId,
  ]);
}

function extractDirectTask(prompt) {
  if (!prompt) return undefined;
  // Linear's promptContext already contains the issue's instruction. For
  // created issue sessions, discard generated project summaries, synced
  // comment banners, agent guidance, and redundant wrapper text. Do not
  // filter the issue description itself: its safety/scope rules are task data.
  const issue = prompt.match(/<issue\b[^>]*identifier="([^"]+)"[^>]*>([\s\S]*?)<\/issue>/);
  if (!issue) return prompt;
  const title = issue[2].match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
  const description = issue[2].match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim();
  if (!title || !description) return prompt;
  const request = prompt.match(/<user-request>([\s\S]*?)<\/user-request>/)?.[1]?.trim();
  const isGenericRequest = request && /^Work on \[?[A-Z]+-\d+/i.test(request);
  return [
    `Issue: ${issue[1]}`,
    `Title: ${title}`,
    "",
    description,
    ...(request && !isGenericRequest ? ["", "Request:", request] : []),
  ].join("\n");
}

function extractPromptContext(job) {
  return firstString([
    job?.payload?.data?.promptContext,
    job?.payload?.original?.data?.promptContext,
    job?.payload?.original?.promptContext,
    job?.payload?.original?.data?.agentSession?.promptContext,
  ]);
}

function firstString(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
}

function buildGenericArgs(template, prompt, jobFile, workspace) {
  const promptToken = "__AGENT_BRIDGE_PROMPT__";
  const jobFileToken = "__AGENT_BRIDGE_JOB_FILE__";
  const workspaceToken = "__AGENT_BRIDGE_WORKSPACE__";

  const templated = template
    .replaceAll("{{PROMPT}}", promptToken)
    .replaceAll("{{JOB_FILE}}", jobFileToken)
    .replaceAll("{{WORKSPACE}}", workspaceToken);

  return shellLikeSplit(templated).map((arg) =>
    arg
      .replaceAll(promptToken, prompt)
      .replaceAll(jobFileToken, jobFile)
      .replaceAll(workspaceToken, workspace),
  );
}

function shellLikeSplit(value) {
  const args = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function maskArg(arg) {
  if (arg.length > 120) return `${arg.slice(0, 120)}...`;
  return arg;
}

function attachProcessLogs(child, label, jobKey, external = false) {
  let launchError = false;
  child.on("spawn", () => { void jobStore.transition(jobKey, "running", { pid: child.pid }).catch(console.error); });
  child.stdout.on("data", (data) => {
    console.log(`[${label}-Out]: ${data.toString().trim()}`);
  });

  child.stderr.on("data", (data) => {
    console.error(`[${label}-Err]: ${data.toString().trim()}`);
  });

  child.on("error", (error) => {
    launchError = true;
    void jobStore.transition(jobKey, "failed", { error: error.message }).catch(console.error);
    console.error(`[${label}-Spawn-Error]: ${error.message}`);
  });

  child.on("close", (code, signal) => {
    if (!launchError) {
      const state = code === 0 ? (external ? "awaiting_external" : "completed") : "failed";
      void jobStore.transition(jobKey, state, { exitCode: code, signal }).catch(console.error);
    }
    console.log(`[${label}-Exit]: code=${code ?? "null"} signal=${signal ?? "none"}`);
  });
}

function normalizeHost(hostHeader) {
  return String(hostHeader || "").split(":")[0].toLowerCase();
}

function matchesHost(actualHost, expectedHost) {
  return actualHost === expectedHost || actualHost.endsWith(`.${expectedHost}`);
}

function agentForHost(host) {
  if (matchesHost(host, MOCK_HOST)) return "mock";
  if (matchesHost(host, ANTIGRAVITY_HOST)) return "antigravity";
  if (matchesHost(host, CHATGPT_HOST)) return "chatgpt";
  if (matchesHost(host, TRAE_HOST)) return "trae";
  if (matchesHost(host, GEMINI_HOST)) return "gemini";
  return "unknown";
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    request.on("data", (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > 1_000_000) {
        reject(new Error("Body too large"));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

  response.end(JSON.stringify(body, null, 2));
}
