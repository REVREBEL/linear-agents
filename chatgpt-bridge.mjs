import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const PORT = Number(process.env.BRIDGE_PORT || 8788);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const SHARED_SECRET = process.env.BRIDGE_SHARED_SECRET;
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || "";
const LINEAR_ACCESS_TOKEN = process.env.LINEAR_ACCESS_TOKEN || "";

const PROJECT_DIR = path.dirname(new URL(import.meta.url).pathname);
const JOBS_DIR = path.join(PROJECT_DIR, "linear-jobs");
const PYTHON_BIN =
  process.env.PYTHON_BIN || path.join(PROJECT_DIR, ".venv", "bin", "python");
const RUN_AGENT_PATH = path.join(PROJECT_DIR, "run_agent.py");

if (!SHARED_SECRET) {
  console.error("Missing BRIDGE_SHARED_SECRET environment variable.");
  process.exit(1);
}

await fs.mkdir(JOBS_DIR, { recursive: true });

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return sendJson(response, 200, {
        ok: true,
        service: "antigravity-mac-bridge",
        python: PYTHON_BIN,
        runner: RUN_AGENT_PATH,
      });
    }

    if (request.method !== "POST" || request.url !== "/jobs") {
      return sendJson(response, 404, { ok: false, error: "Not found" });
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
    const filename = path.join(JOBS_DIR, `${safeJobId}.json`);

    await fs.writeFile(filename, JSON.stringify(job, null, 2), "utf8");

    console.log("\nLinear job received");
    console.log(`Saved to: ${filename}`);

    const original = job?.payload?.original ?? {};
    const originalType = original?.type;
    const sessionId =
      original?.data?.id ??
      original?.agentSession?.id ??
      original?.data?.agentSession?.id ??
      original?.agentSessionId ??
      original?.data?.agentSessionId;

    if (originalType === "AgentSessionEvent" && sessionId) {
      console.log(`Valid Agent Session verified (${sessionId}). Spawning local engine...`);
      console.log(`Python: ${PYTHON_BIN}`);

      const agentProcess = spawn(
        PYTHON_BIN,
        [RUN_AGENT_PATH, sessionId, filename],
        {
          cwd: PROJECT_DIR,
          env: {
            ...process.env,
            LINEAR_API_KEY,
            LINEAR_ACCESS_TOKEN,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      agentProcess.stdout.on("data", (data) => {
        console.log(`[Agent-Out]: ${data.toString().trim()}`);
      });

      agentProcess.stderr.on("data", (data) => {
        console.error(`[Agent-Err]: ${data.toString().trim()}`);
      });

      agentProcess.on("error", (error) => {
        console.error(`[Agent-Spawn-Error]: ${error.message}`);
      });

      agentProcess.on("close", (code, signal) => {
        console.log(
          `[Agent-Exit]: code=${code ?? "null"} signal=${signal ?? "none"}`,
        );
      });
    } else {
      console.log(
        `Received non-execution event or missing session ID. type=${originalType || "Unknown"} sessionId=${sessionId || "missing"}`,
      );
    }

    return sendJson(response, 202, {
      ok: true,
      accepted: true,
      jobId: safeJobId,
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
  console.log(`Antigravity bridge listening on http://${HOST}:${PORT}`);
  console.log(`Python runner: ${PYTHON_BIN}`);
});

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