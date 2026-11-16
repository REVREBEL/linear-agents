import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditBridgeDeployment } from "./p5-deployment-readiness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("P5.3 main checkout meets source-level readiness gates", async () => {
  const result = await auditBridgeDeployment({ root });
  assert.equal(result.checkCount, 10);
  assert.deepEqual(result.checks.filter(item => !item.passed), []);
  assert.equal(result.ok, true);
});

test("P5.3 fail-closed: moved runtime job root is rejected without reading live data", async () => {
  const failed = await auditBridgeDeployment({
    root,
    readFile: async file => {
      const source = await fs.readFile(file, "utf8");
      return path.basename(file) === "agent-bridge-runtime.mjs"
        ? source.replace(
            'new URL("../../linear-agent-bridge/agent-bridge.mjs", import.meta.url)',
            "import.meta.url",
          ) : source;
    },
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.checks.filter(item => !item.passed).map(x => x.id), ["runtime-root"]);
});

test("P5.3 fail-closed: wrong systemd loader or account is rejected", async () => {
  const failed = await auditBridgeDeployment({
    root,
    readFile: async file => {
      const source = await fs.readFile(file, "utf8");
      return path.basename(file) === "install-systemd.sh"
        ? source.replace('User=${USER_NAME}', 'User=root') : source;
    },
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.checks.filter(item => !item.passed).map(x => x.id), ["systemd-loader"]);
});

test("P5.3 fail-closed: missing or unreadable source does not leak file contents", async () => {
  const failed = await auditBridgeDeployment({
    root,
    readFile: async file => {
      if (file.endsWith("ssh-dispatch.mjs")) {
        const error = Error("TOP_SECRET_SHOULD_NOT_LEAK");
        error.code = "EACCES";
        throw error;
      }
      return fs.readFile(file, "utf8");
    },
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.checks.filter(x => !x.passed), [{
    id: "ssh-ack", passed: false, reason: "source read failed",
  }]);
  assert.equal(JSON.stringify(failed).includes("TOP_SECRET"), false);
});

test("P5.3 checks preserve production non-mutation boundary", async () => {
  const source = await fs.readFile(new URL("./p5-deployment-readiness.mjs", import.meta.url), "utf8");
  for (const unexpected of [
    "systemctl restart", "systemctl stop", "systemctl start",
    "POST /jobs", "fetch(", "spawn(", "exec(", "process.env.BRIDGE_SHARED_SECRET",
    'readFile(".env")',
  ]) assert.equal(source.includes(unexpected), false, unexpected);
});
