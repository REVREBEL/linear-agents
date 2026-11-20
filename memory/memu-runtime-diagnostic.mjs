import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadMemuRuntime } from "./memu-runtime.mjs";

const execFileAsync = promisify(execFile);
const QUERY = `SELECT json_build_object(
  'pgvectorVersion', (SELECT extversion FROM pg_extension WHERE extname='vector'),
  'fileCount', (SELECT count(*) FROM memu.recall_files),
  'segmentCount', (SELECT count(*) FROM memu.recall_file_segments),
  'resourceCount', (SELECT count(*) FROM memu.resources),
  'minDimension', (SELECT min(vector_dims(embedding)) FROM memu.recall_file_segments),
  'maxDimension', (SELECT max(vector_dims(embedding)) FROM memu.recall_file_segments),
  'vectorIndexCount', (SELECT count(*) FROM pg_indexes
     WHERE schemaname='memu' AND indexdef ~* '(hnsw|ivfflat)')
)::text`;

/** Read-only inspection on the approved bridge host. No DSN in argv or logs. */
export async function probeLocalMemuPostgres({ execImpl = execFileAsync } = {}) {
  const { stdout } = await execImpl("/usr/bin/psql",
    ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", QUERY], {
      env: { PATH: "/usr/bin:/bin", PGHOST: "/var/run/postgresql",
        PGPORT: "5433", PGDATABASE: "agent_memory" },
      timeout: 5000, maxBuffer: 4096, encoding: "utf8",
    });
  const payload = JSON.parse(stdout.trim());
  if (!payload || typeof payload.pgvectorVersion !== "string" ||
      ![payload.fileCount, payload.segmentCount, payload.resourceCount,
        payload.vectorIndexCount].every(Number.isSafeInteger) ||
      ![payload.minDimension, payload.maxDimension].every(n =>
        n === null || Number.isSafeInteger(n)))
    throw Error("invalid memU PostgreSQL diagnostic");
  return payload;
}

/** Only static status and aggregate row/dimension counts are returned. */
export async function diagnoseMemuRuntime({
  configPath, binary, runtimeLoader = loadMemuRuntime,
  accessImpl = fs.access, dbProbe = probeLocalMemuPostgres,
} = {}) {
  const report = {
    schemaVersion: 1, configPrivate: false, cliExecutable: false,
    localEmbeddingEndpoint: false, embedModel: null,
    databaseConnected: false, database: null,
  };
  let runtime;
  try {
    runtime = await runtimeLoader({ configPath, binary });
    report.configPrivate = true;
    report.localEmbeddingEndpoint = runtime.diagnostics.localEmbeddingEndpoint;
    report.embedModel = runtime.diagnostics.embedModel;
  } catch { return report; }
  try { await accessImpl(runtime.binary, fs.constants.X_OK); report.cliExecutable = true; }
  catch { /* absent CLI is a diagnostic failure, not a reason to log secrets */ }
  try {
    report.database = await dbProbe();
    report.databaseConnected = true;
  } catch { /* disconnected DB is reported without connection details */ }
  return report;
}
