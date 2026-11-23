import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helper = path.join(root, "scripts/linux/shared-volta-preflight.sh");
const user = os.userInfo().username;

function fixture({ node = true, volta = true, executable = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shared-volta-preflight-"));
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  mkdirSync(path.join(dir, "tools/image/node/26.13.0/bin"), { recursive: true });
  if (volta) writeFileSync(path.join(dir, "bin/volta"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (node) writeFileSync(path.join(dir, "bin/node"), "#!/bin/sh\necho v26.13.0\n", { mode: executable ? 0o755 : 0o644 });
  writeFileSync(path.join(dir, "tools/image/node/26.13.0/bin/node"), "#!/bin/sh\necho v26.13.0\n", { mode: 0o755 });
  return dir;
}

function run(dir) {
  return spawnSync("bash", ["-c", `source ${JSON.stringify(helper)} && verify_shared_volta_runtime ${JSON.stringify(dir)} ${JSON.stringify(user)}`], { encoding: "utf8" });
}

test("shared Volta preflight accepts a complete runtime executable by the service account", () => {
  const dir = fixture();
  try { assert.equal(run(dir).status, 0); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shared Volta preflight rejects a missing runtime", () => {
  const dir = path.join(os.tmpdir(), `missing-volta-${process.pid}`);
  const result = run(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime missing/);
});

test("shared Volta preflight rejects missing or non-executable shims", () => {
  for (const options of [{ volta: false }, { node: false }, { executable: false }]) {
    const dir = fixture(options);
    try { assert.notEqual(run(dir).status, 0); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("both systemd installers run shared runtime preflight only for install/replace", () => {
  for (const name of ["install-systemd.sh", "install-github-event-publisher.sh"]) {
    const source = requireSource(name);
    assert.match(source, /source .*shared-volta-preflight\.sh/);
    assert.match(source, /verify_shared_volta_runtime "\/opt\/global-tools\/volta" "\$\{USER_NAME\}"/);
  }
});

function requireSource(name) {
  return readFileSync(path.join(root, "scripts/linux", name), "utf8");
}
