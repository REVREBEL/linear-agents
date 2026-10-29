import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Compile this pure TypeScript helper in memory so Node can run tests
// without compiling or scanning unrelated repositories.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "shared/oauth-errors.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const { isInvalidGrant, ReauthorizationRequiredError } = await import(
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
