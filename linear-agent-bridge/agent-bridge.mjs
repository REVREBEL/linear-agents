import { syncLinearCredential } from "./linear-credentials.mjs";
import { sanitizeGithubEvent, recordGithubEvent, resolveGithubReviewDestination, shouldDispatchGithubReview, buildGithubReviewPrompt } from "./github-events.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createJobStore } from "./job-store.mjs";
import { createSessionQueue } from "./agy-session-queue.mjs";
import { recordResumedConversation } from "./agy-conversation-state.mjs";

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
const agySessionQueue = createSessionQueue();
// Serialize automated ChatGPT handoffs across the shared Chrome CDP browser.
// Different conversations share the same browser process and visible tabs.
let chatgptHandoffTail = Promise.resolve();
function enqueueChatgptHandoff(task) {
  const running = chatgptHandoffTail.catch(() => {}).then(task);
  chatgptHandoffTail = running.catch(error => {
    console.error("ChatGPT handoff queue error:", error);
  });
  return running;
}

async function prepareGithubShortcutHandoff(event, source) {
  if (!shouldDispatchGithubReview(event, source)) return null;
  if (process.env.CHATGPT_HANDOFF_MODE !== "shortcuts") {
    throw new Error("GitHub PR review dispatch requires CHATGPT_HANDOFF_MODE=shortcuts");
  }
  const config = JSON.parse(await fs.readFile(ROUTING_CONFIG_FILE, "utf8"));
  const destination = resolveGithubReviewDestination(config, event.repository);
  if (!destination.ok) throw new Error(destination.error);
  const handoffId = crypto.createHash("sha256").update(`github:${source}:${event.delivery}`).digest("hex");
  const handoffDir = path.join(JOBS_DIR, "github-events", "handoffs");
  const handoffFile = path.join(handoffDir, `${source}-${event.delivery}.chatgpt-handoff.json`);
  await fs.mkdir(handoffDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(handoffFile, JSON.stringify({
    conversationUrl: destination.conversationUrl,
    prompt: buildGithubReviewPrompt(event),
    handoffId,
  }, null, 2), { mode: 0o600 });
  return { handoffFile, handoffId };
}

async function claimGithubReviewDispatch(event, source) {
  if (!shouldDispatchGithubReview(event, source)) return null;
  const eventDir = path.join(JOBS_DIR, "github-events");
  await fs.mkdir(eventDir, { recursive: true, mode: 0o700 });
  const dispatchClaim = path.join(eventDir, `${source}-${event.delivery}.review.claim`);
  try { await fs.writeFile(dispatchClaim, event.delivery, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code === "EEXIST") return { duplicate: true };
    throw error;
  }
  try {
    const handoff = await prepareGithubShortcutHandoff(event, source);
    return { ...handoff, dispatchClaim };
  } catch (error) {
    await fs.unlink(dispatchClaim).catch(() => {});
    throw error;
  }
}

function launchGithubShortcutHandoff(handoff) {
  const script = path.resolve(PROJECT_DIR, "../scripts/chatgpt-shortcuts/handoff.mjs");
  void enqueueChatgptHandoff(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--handoff-file", handoff.handoffFile], {
      cwd: path.resolve(PROJECT_DIR, ".."), env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", chunk => console.log("[GitHub ChatGPT handoff] " + String(chunk).trimEnd()));
    child.stderr?.on("data", chunk => console.error("[GitHub ChatGPT handoff] " + String(chunk).trimEnd()));
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`GitHub Shortcut handoff exited with code ${code}`)));
  })).catch(error => console.error("GitHub ChatGPT handoff failed:", error));
}

const ROUTING_CONFIG_FILE = process.env.ROUTING_CONFIG_FILE || path.join(PROJECT_DIR, "routing.json");
const AGY_PROJECT_CONVERSATIONS_DIR = path.join(JOBS_DIR, "project-conversations");
async function readAgyProjectConversation(projectId, workspace) {
  const file = path.join(AGY_PROJECT_CONVERSATIONS_DIR, projectId + ".json");
  try {
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    return record.workspace === workspace &&
      typeof record.conversationId === "string" &&
      /^[a-zA-Z0-9_-]{8,128}$/.test(record.conversationId) ? record.conversationId : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function saveAgyProjectConversation(projectId, workspace, conversationId) {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(conversationId)) {
    throw new Error("Cannot persist invalid AGY conversation ID");
  }
  await fs.mkdir(AGY_PROJECT_CONVERSATIONS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(AGY_PROJECT_CONVERSATIONS_DIR, projectId + ".json");
  const temporary = file + "." + process.pid + ".tmp";
  try {
    await fs.writeFile(temporary, JSON.stringify({
      projectId, workspace, conversationId, updatedAt: new Date().toISOString()
    }, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

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
        antigravityMode: process.env.ANTIGRAVITY_MODE || "cli",
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

    // Probe is authenticated and side-effect free: no job IDs, ledger entries,
    // workspace writes, or agent process launches.
    if (request.method === "POST" && url.pathname === "/diagnostics/probe") {
      if (!SHARED_SECRET || request.headers.authorization !== `Bearer ${SHARED_SECRET}`) {
        return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      }
      const probeId = request.headers["x-bridge-probe-id"];
      if (typeof probeId !== "string" || !/^[a-f0-9-]{36}$/i.test(probeId)) {
        return sendJson(response, 400, { ok: false, error: "Invalid probe ID" });
      }
      return sendJson(response, 200, {
        ok: true,
        probeId,
        service: "local-linear-agent-router",
        agent: agentForHost(host),
      });
    }

    // Shortcuts may construct a URL with &handoffid= before the ?result suffix.
    // Accept that legacy format as well as normal URL query parameters.
    const shortcutLegacyMatch = new RegExp("^/github/handoff-result&handoffid=([a-zA-Z0-9_-]{8,128})$").exec(url.pathname);
    if (request.method === "GET" && (url.pathname === "/github/handoff-result" || shortcutLegacyMatch)) {
      const handoffId = shortcutLegacyMatch?.[1] || url.searchParams.get("handoffid") || url.searchParams.get("handoffId");
      const allowed = { "success": "success", "cancelled": "cancelled", "error": "error",
        "x-success": "success", "x-cancelled": "cancelled", "x-error": "error" };
      const outcomeFlags = [...url.searchParams.keys()].filter(key => Object.hasOwn(allowed, key));
      if (outcomeFlags.length !== 1 || (handoffId !== null && !/^[a-zA-Z0-9_-]{8,128}$/.test(handoffId))) {
        return sendJson(response, 400, { ok: false, error: "Use ?success, ?cancelled or ?error, optionally with handoffid" });
      }
      const status = allowed[outcomeFlags[0]];
      const record = { at: new Date().toISOString(), status, source: "shortcuts", stage: "handoff",
        ...(handoffId ? { handoffId } : {}) };
      const resultDir = path.join(JOBS_DIR, "chatgpt", "handoff-results");
      await fs.mkdir(resultDir, { recursive: true, mode: 0o700 });
      await fs.appendFile(path.join(resultDir, "results.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
      console.log(`ChatGPT Shortcut signal: ${status} ${handoffId || "(unassigned)"}`);
      return sendJson(response, 200, { ok: true, status, ...(handoffId ? { handoffId } : {}) });
    }

    if (url.pathname === "/github/handoff-result") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { ok: false, error: "Use POST to report a Shortcut handoff result" });
      }
      const callbackToken = process.env.CHATGPT_HANDOFF_CALLBACK_TOKEN;
      if (!callbackToken) return sendJson(response, 503, { ok: false, error: "Shortcut callback token not configured" });
      const supplied = request.headers.authorization;
      const expected = `Bearer ${callbackToken}`;
      if (typeof supplied !== "string" ||
          Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      }
      let payload;
      try { payload = JSON.parse(await readBody(request)); }
      catch { return sendJson(response, 400, { ok: false, error: "Invalid JSON payload" }); }
      const handoffId = payload?.handoffId;
      const status = payload?.status;
      const stage = payload?.stage;
      if (typeof handoffId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(handoffId) ||
          !["success", "error"].includes(status) ||
          typeof stage !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(stage) ||
          (payload.error !== undefined && (typeof payload.error !== "string" || payload.error.length > 500))) {
        return sendJson(response, 400, { ok: false, error: "Invalid handoff result" });
      }
      const record = { at: new Date().toISOString(), handoffId, status, stage,
        ...(status === "error" && payload.error ? { error: payload.error } : {}) };
      const resultDir = path.join(JOBS_DIR, "chatgpt", "handoff-results");
      await fs.mkdir(resultDir, { recursive: true, mode: 0o700 });
      await fs.appendFile(path.join(resultDir, "results.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
      console.log(`ChatGPT Shortcut handoff result: ${handoffId} ${status} ${stage}`);
      return sendJson(response, 202, { ok: true, accepted: true, handoffId, status });
    }

    if (request.method === "POST" && url.pathname === "/github/events") {
      if (request.headers.authorization !== `Bearer ${SHARED_SECRET}`) {
        return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      }
      const source = request.headers["x-github-agent"];
      if (source !== "chatgpt" && source !== "antigravity") {
        return sendJson(response, 400, { ok: false, error: "Unknown GitHub agent" });
      }
      let event;
      try { event = sanitizeGithubEvent(JSON.parse(await readBody(request))); }
      catch (error) { return sendJson(response, 400, { ok: false, error: error.message }); }
      const eventDir = path.join(JOBS_DIR, "github-events");
      // Atomic create prevents duplicate webhook retries from being journaled twice.
      await fs.mkdir(eventDir, { recursive: true, mode: 0o700 });
      const claimFile = path.join(eventDir, `${source}-${event.delivery}.claim`);
      try { await fs.writeFile(claimFile, event.delivery, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if (error.code === "EEXIST") {
          try {
            const recovered = await claimGithubReviewDispatch(event, source);
            if (recovered && !recovered.duplicate) {
              launchGithubShortcutHandoff(recovered);
              return sendJson(response, 202, { ok: true, duplicate: true, recoveredReviewDispatch: true,
                delivery: event.delivery, handoffId: recovered.handoffId, reviewDispatched: true });
            }
            return sendJson(response, 202, { ok: true, duplicate: true, delivery: event.delivery,
              reviewDispatched: recovered?.duplicate === true });
          } catch (recoveryError) {
            return sendJson(response, 422, { ok: false, duplicate: true, error: recoveryError.message });
          }
        }
        throw error;
      }
      let handoff;
      try {
        handoff = await claimGithubReviewDispatch(event, source);
        await recordGithubEvent(JOBS_DIR, event, source);
        if (handoff && !handoff.duplicate) launchGithubShortcutHandoff(handoff);
        console.log(`GitHub event recorded: ${source} ${event.event} ${event.action} ${event.repository || ""} ${event.number || ""}`);
        return sendJson(response, 202, { ok: true, accepted: true, delivery: event.delivery,
          ...(handoff && !handoff.duplicate ? { handoffId: handoff.handoffId, reviewDispatched: true } : { reviewDispatched: handoff?.duplicate === true }) });
      } catch (error) {
        await fs.unlink(claimFile).catch(() => {});
        if (handoff?.dispatchClaim) await fs.unlink(handoff.dispatchClaim).catch(() => {});
        return sendJson(response, 422, { ok: false, error: error.message });
      }
    }

    if (request.method === "POST" && url.pathname === "/issue-completed") {
      if (request.headers.authorization !== `Bearer ${SHARED_SECRET}`) {
        return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      }
      const body = JSON.parse(await readBody(request));
      const issueId = body?.issueId;
      if (typeof issueId !== "string" || !/^[a-f0-9-]{36}$/i.test(issueId)) {
        return sendJson(response, 400, { ok: false, error: "Invalid issueId" });
      }
      const records = await jobStore.findByIssueId(issueId);
      let cleaned = 0;
      for (const record of records) {
        const file = record.taskFile;
        if (typeof file !== "string" || !file.endsWith(".json") ||
            !file.includes(`${path.sep}.linear-agent${path.sep}projects${path.sep}`) ||
            !file.includes(`${path.sep}inbox${path.sep}`)) continue;
        await fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
        await jobStore.transition(record.key, record.state, { inboxClearedAt: new Date().toISOString() });
        cleaned++;
      }
      return sendJson(response, 200, { ok: true, issueId, cleaned });
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
      const state = claimed.record?.state || "claimed";
      // An old failed/unrouted/partial claim must not be reported to the
      // Worker as successfully delivered. Manual reconciliation is required.
      if (["claimed", "received", "unrouted", "failed", "interrupted"].includes(state)) {
        return sendJson(response, 503, {
          ok: false, accepted: false, duplicate: true, state,
          error: "Existing delivery was not accepted; inspect local job ledger before replay",
        });
      }
      return sendJson(response, 202, {
        ok: true, accepted: true, duplicate: true, jobId: claimed.record?.jobId || safeJobId,
        state, host,
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

    const credential = await syncLinearCredential({
      agent,
      repositoryRoot: route.repositoryRoot,
      organizationId: job.organizationId,
      completionUrl: job.completionUrl || job.payload?.data?.completionUrl,
      sharedSecret: SHARED_SECRET,
    });
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
      issueId: job.issueMetadata?.id || job.issueId || null,
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
        agentRole: route.agentRole,
        codeReviewRole: route.codeReviewRole,
        agyConversationMode: route.agyConversationMode,
        agyConversationId: route.agyConversationId,
      },
    }, null, 2), { mode: 0o600 });

    await jobStore.transition(jobKey, "queued", { taskFile: filename, repositoryRoot: route.repositoryRoot, workspace, agentSessionId: job.agentSessionId || job.payload?.data?.agentSessionId, issueId: job.issueMetadata?.id || job.issueId || null });
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
      const sessionId = extractAgentSessionId(routedJob);
      // Shared project conversations must not receive concurrent invocations.
      const projectConversationQueueKey = route.agyConversationMode === "reuse-existing"
        ? "project:" + route.projectId : sessionId;
      void agySessionQueue.enqueue(projectConversationQueueKey, async () => {
        let conversationId = route.agyConversationId || null;
        let conversationSource = conversationId ? "project_reuse" : "follow_up";
        if (route.agyConversationMode === "reuse-existing" && !conversationId) {
          conversationId = await readAgyProjectConversation(route.projectId, workspace);
          if (conversationId) conversationSource = "project_reuse";
        }
        if (!conversationId && route.agyConversationMode !== "reuse-existing" && routedJob.sessionAction === "prompted") {
          const prior = await jobStore.findLatestConversationBySessionId(sessionId, jobKey, workspace);
          conversationId = prior?.conversationId || null;
        }
        // Cross-session recovery is opt-in and never supersedes same-session continuity.
        if (!conversationId && route.agyConversationMode !== "reuse-existing" && routedJob.sessionAction !== "prompted" && process.env.ANTIGRAVITY_ISSUE_RECOVERY_ENABLED === "true") {
          const issueId = routedJob.issueMetadata?.id || routedJob.issueId || null;
          const prior = await jobStore.findLatestCompletedConversationByIssueId(issueId, sessionId, workspace, jobKey);
          if (prior) {
            conversationId = prior.conversationId;
            conversationSource = "issue_recovery";
            await jobStore.transition(jobKey, "launching", {
              recoveredFromAgentSessionId: prior.agentSessionId,
              recoveredFromJobKey: prior.key,
            });
          }
        }
        await recordResumedConversation(jobStore, jobKey, conversationId, conversationSource);
        const actualConversationId = await startAntigravity(
          routedJob, filename, workspace, jobKey, conversationId,
          route.agyConversationMode === "reuse-existing"
            ? async id => saveAgyProjectConversation(route.projectId, workspace, id)
            : null, credential
        );
        if (route.agyConversationMode === "reuse-existing" && actualConversationId) {
          await saveAgyProjectConversation(route.projectId, workspace, actualConversationId);
          console.log(`[Antigravity] Project ${route.projectId} conversation: ${actualConversationId}`);
        } else if (route.agyConversationMode === "reuse-existing") {
          console.warn(`[Antigravity] Project ${route.projectId}: no verified conversation ID; next delivery will start fresh`);
        }
      }).catch(async error => {
        console.error("AGY queued execution failed:", error);
        await jobStore.transition(jobKey, "failed", { error: String(error) }).catch(console.error);
      });
    } else if (agent === "chatgpt") {
      if (!route.chatgptProjectUrl) {
        await jobStore.transition(jobKey, "failed", { error: "No chatgpt.projectUrl in Linear project mapping" });
        console.error("ChatGPT handoff stopped: project mapping has no chatgpt.projectUrl");
      } else if (["supervised-playwright", "shortcuts"].includes(process.env.CHATGPT_HANDOFF_MODE) || route.chatgptAutoSend === true) {
        const promptContext = extractPromptContext(routedJob);
        if (!promptContext) {
          await jobStore.transition(jobKey, "failed", { error: "Missing ChatGPT promptContext" });
        } else {
          const useShortcuts = process.env.CHATGPT_HANDOFF_MODE === "shortcuts";
          const script = path.resolve(PROJECT_DIR, useShortcuts
            ? "../scripts/chatgpt-shortcuts/handoff.mjs"
            : "../scripts/chatgpt-playwright/handoff-test.mjs");
          // This supervised test requires an attached terminal, and must not consume the daemon stdin.
          // Queue a ready-to-run handoff command as a local file instead of launching UI automation from launchd.
          const handoffFile = filename + ".chatgpt-handoff.json";
          const handoffId = safeJobId;
          // Mark automated ChatGPT submissions clearly without changing the original job prompt.
          const automatedPrompt = promptContext.startsWith("Linear Bridge Automated Prompt:")
            ? promptContext
            : `Linear Bridge Automated Prompt: ${promptContext}`;
          const handoffPayload = useShortcuts
            ? { conversationUrl: route.chatgptProjectUrl, prompt: automatedPrompt, handoffId }
            : { projectUrl: route.chatgptProjectUrl, conversationMode: route.chatgptConversationMode, autoSend: route.chatgptAutoSend === true, prompt: automatedPrompt, jobFile: filename };
          await fs.writeFile(handoffFile, JSON.stringify(handoffPayload, null, 2), { mode: 0o600 });
          if (route.chatgptAutoSend === true) {
            const handoffController = useShortcuts ? "Apple Shortcut" : "Playwright";
            await jobStore.transition(jobKey, "awaiting_external", { handoffFile, handoffId, note: `Automatic ${handoffController} submission launched; response processing not implemented` });
            void enqueueChatgptHandoff(() => new Promise((resolve, reject) => {
              const childArgs = useShortcuts
                ? [script, "--handoff-file", handoffFile]
                : [script, "--handoff-file", handoffFile, "--auto-send", "--keep-open"];
              const child = spawn(process.execPath, childArgs, {
                cwd: path.resolve(PROJECT_DIR, ".."), env: process.env, stdio: ["ignore", "pipe", "pipe"],
              });
              child.stdout?.on("data", chunk => console.log("[ChatGPT handoff] " + String(chunk).trimEnd()));
              child.stderr?.on("data", chunk => console.error("[ChatGPT handoff] " + String(chunk).trimEnd()));
              child.once("error", reject);
              child.once("close", code => code === 0 ? resolve() : reject(new Error(`${handoffController} handoff exited with code ${code}`)));
            })).catch(async error => {
              console.error("Automatic ChatGPT handoff failed:", error);
              await jobStore.transition(jobKey, "failed", { error: String(error) }).catch(e => console.error("Unable to record ChatGPT handoff failure:", e));
            });
          } else {
            const handoffController = useShortcuts ? "Apple Shortcut" : "Playwright";
            await jobStore.transition(jobKey, "awaiting_external", { handoffFile, handoffId, note: `Supervised ${handoffController} handoff ready; run manually` });
            console.log(`ChatGPT ${handoffController} handoff ready: ${handoffFile}`);
            console.log(`Run: node ${script} --handoff-file ${handoffFile}`);
          }
        }
      } else {
        await jobStore.transition(jobKey, "awaiting_external", { note: "ChatGPT task saved; set CHATGPT_HANDOFF_MODE=supervised-playwright or shortcuts to prepare a browser handoff" });
      }
    } else if (agent === "trae") {
      startTrae(routedJob, filename, workspace, jobKey, credential);
    } else if (agent === "gemini") {
      await startGemini(routedJob, filename, workspace, jobKey, credential);
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
  console.log(`Antigravity mode: ${process.env.ANTIGRAVITY_MODE || "cli"}`);
  console.log(`ChatGPT workspace: ${CHATGPT_WORKSPACE}`);
  console.log(`Trae runner: ${TRAE_BIN || "not configured"}`);
  console.log(`Trae workspace: ${TRAE_WORKSPACE}`);
  console.log(`Gemini runner: ${GEMINI_BIN || "not configured"}`);
  console.log(`Gemini workspace: ${GEMINI_WORKSPACE}`);
  console.log(`Projects root: ${PROJECTS_ROOT}`);
  console.log(`Jobs directory: ${JOBS_DIR}`);
  console.log(`Python runner: ${PYTHON_BIN}`);
});

// Post scheduler-owned status only after the durable ledger transition succeeds.
async function postAgyRecoveryActivity(record, message, activityType = "thought") {
  if (!SHARED_SECRET || !record?.agentSessionId || !record?.taskFile) return false;
  try {
    const job = JSON.parse(await fs.readFile(record.taskFile, "utf8"));
    const url = job.completionUrl || job.payload?.data?.completionUrl;
    if (!url) throw new Error("Missing completionUrl");
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${SHARED_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentSessionId: record.agentSessionId, activityType, body: message }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok || !(await response.json()).ok) throw new Error(`Activity callback HTTP ${response.status}`);
    return true;
  } catch (error) {
    console.error("[Antigravity] Failed to publish recovery activity:", error);
    return false;
  }
}

function formatAgyRetryDuration(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}m`;
}

function agyRetryQueueKey(record) {
  const projectId = record.taskFile?.match(/[/\\]projects[/\\]([a-zA-Z0-9-]+)[/\\]/)?.[1];
  return projectId ? `project:${projectId}` : record.agentSessionId;
}

const AGY_RETRY_DELAY_MS = Math.max(60000, Number(process.env.AGY_RETRY_DELAY_MS || 7200000));
const agyResumeTimers = new Map();

function scheduleAgyResume(jobKey, resumeAt) {
  clearTimeout(agyResumeTimers.get(jobKey));
  const delay = Math.max(0, new Date(resumeAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    agyResumeTimers.delete(jobKey);
    void (async () => {
      const record = await jobStore.get(jobKey);
      if (record.state !== "waiting_quota" || record.resumeAt !== resumeAt) return;
      if (!record.conversationId || !record.taskFile || !record.repositoryRoot || !record.workspace || !record.agentSessionId) {
        await jobStore.transition(jobKey, "failed", { error: "Incomplete AGY resume metadata" });
        await postAgyRecoveryActivity(record, "Automatic quota retry failed: resume metadata is incomplete.", "error");
        return;
      }
      try {
        await fs.access(record.taskFile);
      } catch {
        await jobStore.transition(jobKey, "failed", { error: "Original task file missing; cannot resume" });
        await postAgyRecoveryActivity(record, "Automatic quota retry failed: original task file is missing.", "error");
        return;
      }
      const job = JSON.parse(await fs.readFile(record.taskFile, "utf8"));
      const updated = await jobStore.transition(jobKey, "launching", { resumeAt: null });
      await agySessionQueue.enqueue(agyRetryQueueKey(record), async () => {
        await postAgyRecoveryActivity(record, "Quota recovery started. Resuming the existing Antigravity conversation.");
        await recordResumedConversation(jobStore, jobKey, updated.conversationId, "quota_retry");
        await startAntigravity(job, record.taskFile, record.workspace, jobKey, updated.conversationId);
      });
    })().catch(async error => {
      console.error("AGY scheduled resume failed:", error);
      const record = await jobStore.get(jobKey).catch(() => null);
      if (record) await postAgyRecoveryActivity(record, `Automatic quota retry failed: ${error.message}`, "error");
    });
  }, Math.min(delay, 2147483647));
  agyResumeTimers.set(jobKey, timer);
}

function startAntigravity(job, filename, workspace, jobKey, conversationId = null, onVerifiedConversation = null, credential = null) {
  return new Promise((resolve, reject) => {
  const sessionId = extractAgentSessionId(job);

  if (!sessionId) {
    void jobStore.transition(jobKey, "failed", { error: "Missing Linear agent session ID" }).catch(console.error);
    console.log("Antigravity skipped. Missing Linear agent session ID.");
    reject(new Error("Missing Linear agent session ID"));
    return;
  }

  console.log(`Antigravity Agent Session verified (${sessionId}). Spawning local engine...`);

  // Linear Agent Activities require the app installation's OAuth token, which
  // is intentionally held only by the Worker. Do not expose personal Linear
  // credentials to AGY: its textual result is relayed through /complete below.
  const antigravityEnv = { ...process.env };
  delete antigravityEnv.LINEAR_API_KEY;
  delete antigravityEnv.LINEAR_ACCESS_TOKEN;
  // Python owns the completion callback; AGY itself must not inherit the secret.
  // The Python runner strips BRIDGE_SHARED_SECRET from its own child process.

  const agentProcess = spawn(
    PYTHON_BIN,
    [RUN_AGENT_PATH, sessionId, filename, ...(conversationId ? [conversationId] : [])],
    {
      cwd: PROJECT_DIR,
      env: {
        ...antigravityEnv,
        ANTIGRAVITY_WORKSPACE: workspace,
        ...(credential ? { [credential.variable]: credential.accessToken } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // AGY emits a structured exhaustion event; only that event schedules a retry.
  // Keep the same Linear agent session and explicitly resume the AGY conversation.
  let output = "";
  let exhaustionEvent = null;
  let verifiedConversationId = conversationId;
  let conversationPersist = Promise.resolve();
  agentProcess.on("spawn", () => { void jobStore.transition(jobKey, "running", { pid: agentProcess.pid }).catch(console.error); });
  agentProcess.stdout.on("data", data => {
    output += String(data);
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      if (line.startsWith("AGY_BRIDGE_EVENT=")) {
        try {
          const parsed = JSON.parse(line.slice("AGY_BRIDGE_EVENT=".length));
          if (parsed.event === "conversation_started" && parsed.conversation_id) {
            verifiedConversationId = parsed.conversation_id;
            if (onVerifiedConversation) {
              conversationPersist = conversationPersist.then(() => onVerifiedConversation(verifiedConversationId));
              conversationPersist.catch(error => console.error("AGY conversation persistence failed:", error));
            }
            void jobStore.transition(jobKey, "running", { conversationId: verifiedConversationId, conversationVerifiedAt: new Date().toISOString() }).catch(console.error);
          } else if (parsed.event === "on_exhaustion") exhaustionEvent = parsed;
        } catch (error) { console.error("Invalid AGY exhaustion event:", error.message); }
      } else if (line) console.log("[Antigravity-Out]:", line);
    }
  });
  agentProcess.stderr.on("data", data => console.error("[Antigravity-Err]:", String(data).trimEnd()));
  agentProcess.on("error", error => { void jobStore.transition(jobKey, "failed", { error: error.message }).catch(console.error); reject(error); });
  agentProcess.on("close", (code, signal) => {
    void (async () => {
      await conversationPersist;
      if (code === 75 && exhaustionEvent?.event === "on_exhaustion") {
        const conversationId = exhaustionEvent.conversation_id || verifiedConversationId;
        if (!conversationId) {
          await jobStore.transition(jobKey, "failed", { error: "Quota exhausted but AGY conversation ID could not be established; automatic resume refused." });
          await postAgyRecoveryActivity({ agentSessionId: sessionId, taskFile: filename }, "Quota exhausted, but no conversation ID was available. Automatic recovery cannot proceed.", "error");
          return;
        }
        const previous = await jobStore.get(jobKey);
        const attempts = previous.resumeAttempts || 0;
        if (attempts >= 3) {
          await jobStore.transition(jobKey, "failed", { error: "Exhaustion retry limit reached", resumeAttempts: attempts });
          await postAgyRecoveryActivity({ agentSessionId: sessionId, taskFile: filename }, "Antigravity quota recovery stopped: maximum of 3 retries reached.", "error");
          return;
        }
        const resumeAt = new Date(Date.now() + AGY_RETRY_DELAY_MS).toISOString();
        await jobStore.transition(jobKey, "waiting_quota", {
          conversationId, resumeAt, resumeAttempts: attempts + 1,
          pid: null, exitCode: code,
        });
        console.log(`[Antigravity] on_exhaustion: conversation ${conversationId}; resume at ${resumeAt}`);
        await postAgyRecoveryActivity({ agentSessionId: sessionId, taskFile: filename },
          `Quota exhausted. Conversation preserved. Automatic retry ${attempts + 1} of 3 scheduled for ${resumeAt} (in approximately ${formatAgyRetryDuration(new Date(resumeAt).getTime() - Date.now())}).`);
        scheduleAgyResume(jobKey, resumeAt);
      } else {
        await jobStore.transition(jobKey, code === 0 ? "completed" : "failed", { exitCode: code, signal, pid: null });
      }
    })().then(() => resolve(verifiedConversationId), error => { console.error("Antigravity completion handling failed:", error); reject(error); });
  });
  });
}

// Recover scheduled AGY quota retries after a bridge restart.
void jobStore.findByState("waiting_quota").then(records => {
  for (const record of records) {
    if (record.resumeAt) scheduleAgyResume(record.key, record.resumeAt);
  }
}).catch(error => console.error("AGY retry recovery failed:", error));

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

function startTrae(job, filename, workspace, jobKey, credential) {
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
      LINEAR_API_KEY: "", LINEAR_ACCESS_TOKEN: "",
      [credential.variable]: credential.accessToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  attachProcessLogs(traeProcess, "Trae", jobKey);
}

async function startGemini(job, filename, workspace, jobKey, credential) {
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
      LINEAR_API_KEY: "", LINEAR_ACCESS_TOKEN: "",
      [credential.variable]: credential.accessToken,
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
# Load Gemini's app token from the managed repository environment file.
bridge_env_file=${shellQuote(path.join(workspace, ".env.linear-bridge"))}
if [[ ! -f "$bridge_env_file" ]]; then
  print -u2 -- "Gemini launch stopped: missing .env.linear-bridge"
  exit 1
fi
source "$bridge_env_file"
if [[ -z \${GEMINI_LINEAR_API_KEY:-} ]]; then
  print -u2 -- "Gemini launch stopped: no Gemini App token"
  exit 1
fi
export GEMINI_LINEAR_API_KEY
unset LINEAR_API_KEY LINEAR_ACCESS_TOKEN
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
  // Roles own their conversation settings; legacy chatgpt config remains supported.
  const roleAgent = project.agent;
  const roleReview = project.codeReview;
  for (const [name, role] of [["agent", roleAgent], ["codeReview", roleReview]]) {
    if (role === undefined) continue;
    if (!role || typeof role !== "object" || Array.isArray(role) ||
        !["antigravity", "chatgpt"].includes(role.provider)) {
      return { ok: false, error: `${name}.provider must be chatgpt or antigravity` };
    }
    if (!["reuse-existing", "new-per-issue"].includes(role.conversationMode)) {
      return { ok: false, error: `${name}.conversationMode must be reuse-existing or new-per-issue` };
    }
    if (role.provider === "antigravity" && role.conversationId !== undefined &&
        (typeof role.conversationId !== "string" ||
         !/^[a-zA-Z0-9_-]{8,128}$/.test(role.conversationId))) {
      return { ok: false, error: `${name}.conversationId must be a valid conversation ID when supplied` };
    }
    if (role.projectName !== undefined &&
        (typeof role.projectName !== "string" || !role.projectName.trim())) {
      return { ok: false, error: `${name}.projectName must be a nonempty string` };
    }
    if (role.projectId !== undefined &&
        (typeof role.projectId !== "string" || !role.projectId.trim())) {
      return { ok: false, error: `${name}.projectId must be a nonempty string` };
    }
    if (role.provider === "chatgpt") {
      const url = role.conversationUrl || role.projectUrl;
      if (role.projectId !== undefined && !/^g-p-[a-zA-Z0-9_-]+$/.test(role.projectId)) {
        return { ok: false, error: `${name}.projectId must be a ChatGPT Project ID` };
      }
      if (url !== undefined) {
        try {
          const parsed = new URL(url);
          const parts = parsed.pathname.split("/").filter(Boolean);
          const validProject = parts.length === 2 && parts[0] === "g" && parts[1].startsWith("g-p-");
          const validConversation = parts.length === 4 && parts[0] === "g" && parts[1].startsWith("g-p-") &&
            parts[2] === "c" && Boolean(parts[3]);
          if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com" ||
              parsed.search || parsed.hash ||
              (role.conversationMode === "reuse-existing" ? !validConversation : !validProject)) {
            return { ok: false, error: `${name} requires a valid ChatGPT URL for its conversationMode` };
          }
          if (role.projectId && role.projectId !== parts[1]) {
            return { ok: false, error: `${name}.projectId does not match the ChatGPT URL` };
          }
        } catch {
          return { ok: false, error: `${name} contains an invalid ChatGPT URL` };
        }
      }
    }
    if (role.autoSend !== undefined && typeof role.autoSend !== "boolean") {
      return { ok: false, error: `${name}.autoSend must be boolean` };
    }
  }
  // Code-review roles are stored independently. Actual review-event dispatch
  // still follows the installed Worker; do not redirect implementation jobs.
  const chatgptRole = roleAgent?.provider === "chatgpt" ? roleAgent : null;
  const chatgptConfig = chatgptRole || project.chatgpt || {};
  const chatgptProjectUrl = chatgptConfig.conversationUrl || chatgptConfig.projectUrl;
  const chatgptConversationMode = chatgptConfig.conversationMode || "new-per-issue";
  const chatgptAutoSend = chatgptConfig.autoSend === true;
  if (chatgptAutoSend && chatgptConversationMode !== "reuse-existing") return { ok: false, error: "ChatGPT autoSend requires reuse-existing conversation mode" };
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
      if (chatgptConfig.projectId !== undefined && segments[1] !== chatgptConfig.projectId) {
        return { ok: false, error: `ChatGPT projectId does not match conversation URL for project ${projectId}` };
      }
      if (destination.protocol !== "https:" || destination.hostname !== "chatgpt.com" ||
          destination.search || destination.hash || !validPath) {
        return { ok: false, error: `Invalid ChatGPT URL or conversationMode for project ${projectId}` };
      }
    } catch {
      return { ok: false, error: `Invalid ChatGPT URL for project ${projectId}` };
    }
  }
  const agyConfig = roleAgent?.provider === "antigravity" ? roleAgent : null;
  return { ok: true, repositoryRoot, projectScope, launchDirectory, scopeKey, projectId, initiativeId,
    chatgptProjectUrl, chatgptConversationMode, chatgptAutoSend,
    agentRole: roleAgent || null, codeReviewRole: roleReview || null,
    agyConversationMode: agyConfig?.conversationMode || null,
    agyConversationId: agyConfig?.conversationMode === "reuse-existing" ? agyConfig.conversationId : null };
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
