import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

// Compile this pure TypeScript helper in memory so Node can run tests
// without compiling or scanning unrelated repositories.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "shared/oauth-errors.ts"), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" });
const { isInvalidGrant, ReauthorizationRequiredError, withRefreshSingleflight } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

test("OAuth invalid_grant is classified for expired refresh token", () => {
  assert.equal(isInvalidGrant(400, '{"error":"invalid_grant"}'), true);
  assert.equal(isInvalidGrant(401, 'invalid_grant: Refresh token expired'), true);
  assert.equal(isInvalidGrant(503, '{"error":"invalid_grant"}'), false);
  assert.equal(isInvalidGrant(400, '{"error":"temporarily_unavailable"}'), false);
});
test("reauthorization error is safe to expose without disclosing tokens", () => {
  const error = new ReauthorizationRequiredError();
  assert.equal(error.name, "ReauthorizationRequiredError");
  assert.match(error.message, /authorization expired/);
});

test("refresh singleflight coalesces concurrent calls and allows a later retry", async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const work = async () => { calls++; await gate; return "token"; };
  const first = withRefreshSingleflight("agent:org-a", work);
  const second = withRefreshSingleflight("agent:org-a", work);
  assert.equal(first, second);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, "token");
  assert.equal(await second, "token");
  await withRefreshSingleflight("agent:org-a", async () => { calls++; return "next"; });
  assert.equal(calls, 2);
});
test("refresh singleflight releases failed attempts for retry", async () => {
  await assert.rejects(withRefreshSingleflight("agent:org-b", () => Promise.reject(new Error("temporary"))));
  assert.equal(await withRefreshSingleflight("agent:org-b", async () => "recovered"), "recovered");
});
