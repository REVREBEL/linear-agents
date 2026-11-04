import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeLinearEnv, syncLinearCredential } from "./linear-credentials.mjs";
test("atomic per-agent workspace file, local Git exclusion and rotation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linear-bridge-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await writeLinearEnv(root, "antigravity", "old-token");
    await writeLinearEnv(root, "gemini", "other-token");
    await writeLinearEnv(root, "antigravity", "new-token");
    const file = path.join(root, ".env.linear-bridge");
    const body = await fs.readFile(file, "utf8");
    assert.match(body, /ANTIGRAVITY_LINEAR_API_KEY="new-token"/);
    assert.match(body, /GEMINI_LINEAR_API_KEY="other-token"/);
    assert.doesNotMatch(body, /old-token/);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal(execFileSync("git", ["-C", root, "status", "--short", "--untracked-files=all"], { encoding: "utf8" }), "");
  } finally { await fs.rm(root, { force: true, recursive: true }); }
});
test("fetches access token from agent Worker without persisting refresh token", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linear-bridge-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const result = await syncLinearCredential({
      agent: "trae", repositoryRoot: root, organizationId: "organization123",
      completionUrl: "https://linear-trae.example.test/complete", sharedSecret: "test-bridge-secret",
      fetchImpl: async (url, options) => {
        assert.equal(url.pathname, "/bridge/access-token");
        assert.equal(options.headers.authorization, "Bearer test-bridge-secret");
        return { ok: true, json: async () => ({ ok: true, accessToken: "app-token", expiresAt: 12345 }) };
      },
    });
    assert.equal(result.variable, "TRAE_LINEAR_API_KEY");
    assert.match(await fs.readFile(path.join(root, ".env.linear-bridge"), "utf8"), /TRAE_LINEAR_API_KEY="app-token"/);
  } finally { await fs.rm(root, { force: true, recursive: true }); }
});
