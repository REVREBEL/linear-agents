#!/usr/bin/env node
// Operator-only read-only SQL smoke check, never prints live memory contents.
import { readScopedMemuFiles } from "../memory/scoped-postgres-recall.mjs";
import { recallDigest } from "../memory/scoped-recall.mjs";

const scope = {
  tenantId: "abr59-isolated-test-tenant",
  agentId: "abr59-isolated-test-agent",
  repositoryId: "REVREBEL/linear-agents",
  issueId: "ABR-59-READ-ONLY-CANARY",
};
const source = {
  scope, sourceGitSha: "a".repeat(40), sourcePath: "docs/synthetic.md",
  revision: 1, expiresAt: "2099-01-01T00:00:00Z",
  content: "ABR59 synthetic read-only scoped authorization probe.",
};
const result = await readScopedMemuFiles({
  scope, approvedSources: new Map([["b".repeat(64), source]]),
  trustedDigests: new Set([recallDigest(source)]),
});
if (result.entries.length !== 0)
  throw Error("unexpected result for reserved synthetic scope");
process.stdout.write(JSON.stringify({
  readOnly: true, approvedRecordsReturned: result.entries.length,
  databaseScopeVerified: false,
}) + "\n");
