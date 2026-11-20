import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { parseMemuConfig, loadMemuRuntime, MEMU_INSTALLED_BINARY } from "./memu-runtime.mjs";
import { retrieveMemuMemory } from "./memu-memory.mjs";
import { diagnoseMemuRuntime, probeLocalMemuPostgres } from "./memu-runtime-diagnostic.mjs";

const raw = [
  "MEMU_MEMORY_MODE=local",
  "MEMU_DB=postgresql+psycopg://opaque-host-db",
  "MEMU_EMBED_PROVIDER=openai",
  "MEMU_EMBED_MODEL=nomic-embed-text",
  "MEMU_BASE_URL=http://127.0.0.1:11434/v1",
  "MEMU_API_KEY=private-evaluation-key",
  "MEMU_CLIENT_ID=host-owned",
].join("\n") + "\n";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "abr59-memu-"));
  const filename = path.join(root, "config.env");
  try {
    await writeFile(filename, raw, { mode: 0o600 });
    return await run({ root, filename });
  } finally { await rm(root, { recursive: true, force: true }); }
}
function successSpawn(output, track = () => {}) {
  return (binary, argv, opts) => {
    track(binary, argv, opts);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(JSON.stringify(output));
      child.emit("close", 0);
    });
    return child;
  };
}
const scope = { tenantId: "tenant", agentId: "qwen",
  repositoryId: "REVREBEL/linear-agents", issueId: "ABR-59" };

test("private host config parses only literal allowlisted keys, never shell code", () => {
  assert.equal(parseMemuConfig(raw).MEMU_EMBED_MODEL, "nomic-embed-text");
  for (const injection of [
    "MEMU_BASE_URL=http://evil.example/v1",
    "MEMU_EMBED_MODEL=other-embedding",
    "MEMU_API_KEY=$(whoami)",
    "MALICIOUS_ENV=1",
    "MEMU_BASE_URL=http://127.0.0.1:11434/v1#leak",
    "MEMU_MEMORY_MODE=cloud",
    "MEMU_DB=postgresql://another\nMEMU_DB=postgresql://again",
  ]) {
    const key = injection.split("=")[0];
    const edited = key === "MALICIOUS_ENV" ? raw + injection + "\n" :
      raw.replace(new RegExp("^" + key + "=.*$", "m"), injection);
    assert.throws(() => parseMemuConfig(edited));
  }
});
test("owner-only regular non-symlink runtime config returns a private child env", async () => {
  await fixture(async ({ filename }) => {
    const runtime = await loadMemuRuntime({ configPath: filename });
    assert.equal(runtime.binary, MEMU_INSTALLED_BINARY);
    assert.equal(runtime.env.MEMU_EMBED_MODEL, "nomic-embed-text");
    assert.equal(runtime.env.MEMU_API_KEY, "private-evaluation-key");
    assert.equal(runtime.env.MEMU_DB, "postgresql+psycopg://opaque-host-db");
    assert.ok(!Object.keys(runtime.env).includes("OPENROUTER_API_KEY"));
    assert.equal(runtime.diagnostics.databaseConfigured, true);
    assert.ok(!JSON.stringify(runtime.diagnostics).includes("private-evaluation-key"));
    assert.ok(!JSON.stringify(runtime.diagnostics).includes("opaque-host-db"));
  });
});
test("insecure permissions, unexpected owner, symlink and alternate binary all deny", async () => {
  await fixture(async ({ filename, root }) => {
    await assert.rejects(loadMemuRuntime({ configPath: filename, uid: 999999 }),
      /ownership/);
    await assert.rejects(loadMemuRuntime({ configPath: filename, binary: "/usr/bin/memu" }),
      /approved/);
    await chmod(filename, 0o644);
    await assert.rejects(loadMemuRuntime({ configPath: filename }), /ownership/);
    await chmod(filename, 0o600);
    const link = path.join(root, "link.env");
    await symlink(filename, link);
    await assert.rejects(loadMemuRuntime({ configPath: link }), /ownership/);
  });
});
test("opt-in retrieval uses approved absolute binary and scoped direct subprocess env", async () => {
  await fixture(async ({ filename }) => {
    let spawned = 0;
    const text = await retrieveMemuMemory("memory recall", {
      enabled: true, configPath: filename, scope,
      spawnImpl: successSpawn({ segments: [{ text: "Approved scoped reference",
        metadata: { scope } }] }, (bin, args, opts) => {
        spawned++;
        assert.equal(bin, MEMU_INSTALLED_BINARY);
        assert.deepEqual(args, ["retrieve", "memory recall"]);
        assert.equal(opts.shell, false);
        assert.equal(opts.env.MEMU_API_KEY, "private-evaluation-key");
      }),
    });
    assert.equal(spawned, 1);
    assert.equal(text, "Approved scoped reference");
  });
});
test("missing, unsafe or disabled runtime does not launch the memory child", async () => {
  await fixture(async ({ filename }) => {
    let spawned = 0;
    const spawnImpl = () => { spawned++; throw Error("unexpected process"); };
    const log = { warn() {} };
    assert.equal(await retrieveMemuMemory("query", {
      enabled: false, configPath: filename, scope, spawnImpl,
    }), "");
    await chmod(filename, 0o644);
    assert.equal(await retrieveMemuMemory("query", {
      enabled: true, configPath: filename, scope, spawnImpl, logger: log,
    }), "");
    assert.equal(spawned, 0);
  });
});

test("diagnostic only returns status, redacts secrets, and handles disconnected DB", async () => {
  const runtime = { binary: MEMU_INSTALLED_BINARY, diagnostics: {
    localEmbeddingEndpoint: true, embedModel: "nomic-embed-text",
  } };
  const ready = await diagnoseMemuRuntime({
    runtimeLoader: async () => runtime, accessImpl: async () => {},
    dbProbe: async () => ({
      pgvectorVersion: "0.8.1", fileCount: 1, segmentCount: 1,
      resourceCount: 0, minDimension: 768, maxDimension: 768, vectorIndexCount: 0,
    }),
  });
  assert.equal(ready.databaseConnected, true);
  assert.equal(ready.database.segmentCount, 1);
  assert.equal(ready.cliExecutable, true);
  assert.ok(!JSON.stringify(ready).includes("private-evaluation-key"));
  const unavailable = await diagnoseMemuRuntime({
    runtimeLoader: async () => runtime, accessImpl: async () => {},
    dbProbe: async () => { throw Error("secret DSN or password"); },
  });
  assert.equal(unavailable.databaseConnected, false);
  assert.equal(unavailable.database, null);
  assert.ok(!JSON.stringify(unavailable).includes("secret DSN"));
});
test("PostgreSQL probe issues one fixed read-only SQL statement without DSN or secrets", async () => {
  const db = await probeLocalMemuPostgres({ execImpl: async (bin, args, opts) => {
    assert.equal(bin, "/usr/bin/psql");
    assert.equal(args[0], "-X");
    assert.match(args.at(-1), /^SELECT json_build_object/);
    assert.doesNotMatch(args.at(-1), /INSERT|UPDATE|DELETE|DROP|CREATE/);
    assert.equal(opts.env.PGDATABASE, "agent_memory");
    assert.ok(!args.join(" ").includes("private"));
    return { stdout: JSON.stringify({ pgvectorVersion: "0.8.1",
      fileCount: 1, segmentCount: 1, resourceCount: 0,
      minDimension: 768, maxDimension: 768, vectorIndexCount: 0 }) };
  } });
  assert.equal(db.maxDimension, 768);
});
test("oversized private config is rejected without reading or executing its contents", async () => {
  await fixture(async ({ filename }) => {
    await writeFile(filename, raw + "A".repeat(8192), { mode: 0o600 });
    await assert.rejects(loadMemuRuntime({ configPath: filename }), /size bounds/);
  });
});
test("synchronous child spawn error fails open without leaking credentials", async () => {
  await fixture(async ({ filename }) => {
    const warnings = [];
    const result = await retrieveMemuMemory("query", {
      enabled: true, configPath: filename, scope,
      spawnImpl: () => { throw Error("a secret could appear in this error"); },
      logger: { warn: x => warnings.push(x) },
    });
    assert.equal(result, "");
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes("secret"));
  });
});
