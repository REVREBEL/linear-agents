import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { candidatesFor, cosine, eligible, lexicalScore, rankingMetrics, runBenchmark }
  from "./recall-benchmark.mjs";

const fixture = JSON.parse(await readFile(new URL("./synthetic-recall.json", import.meta.url)));
const alpha = fixture.queries[0].scope;
const booking = fixture.queries[2].scope;
test("both unrelated repository scopes refuse cross-tenant, agent, issue and repository", () => {
  const a = candidatesFor(fixture.documents, alpha);
  const b = candidatesFor(fixture.documents, booking);
  assert.deepEqual(a.map(x => x.id).sort(),
    ["memory-lifecycle", "memory-review", "memory-unrelated"]);
  assert.deepEqual(b.map(x => x.id).sort(),
    ["booking-children", "booking-dogs", "booking-noise", "booking-rates", "foreign-repo"]);
  assert.ok(!a.some(x => x.id.startsWith("foreign")));
});
test("invalid source SHA, missing revision, poisoned test labels cannot pass fixture admission", () => {
  const clean = fixture.documents[0];
  for (const replacement of [
    { sourceGitSha: "deadbeef" }, { revision: 0 }, { sourcePath: "" },
    { poisoned: true }, { scope: { ...clean.scope, agentId: "another" } },
    { scope: { ...clean.scope, tenantId: "another" } },
    { scope: { ...clean.scope, repositoryId: "another/repo" } },
    { scope: { ...clean.scope, issueId: "ABR-1" } },
  ]) assert.equal(eligible({ ...clean, ...replacement }, alpha), false);
  assert.equal(eligible(clean, alpha), true);
  assert.equal(eligible(clean, alpha, "b".repeat(40)), false);
  assert.equal(candidatesFor(fixture.documents, alpha, "b".repeat(40)).length, 0);
  assert.throws(() => candidatesFor(fixture.documents, alpha, "stale"), /source pin/);
});
test("metric calculations are deterministic and reject nonfinite and mismatched embeddings", () => {
  assert.equal(rankingMetrics(["a", "b"], { a: 3, b: 1 }, 2).ndcg, 1);
  assert.equal(rankingMetrics(["irrelevant", "a"], { a: 3 }, 2).reciprocalRank, .5);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.throws(() => cosine([1, 0], [1]), /dimension mismatch/);
  assert.throws(() => cosine([NaN], [1]), /nonfinite/);
  assert.equal(lexicalScore("rate cards", "rate cards for booking") > 0, true);
});
test("synthetic-only default run produces scoped, bounded and reproducible results", async () => {
  const a = await runBenchmark(fixture);
  const b = await runBenchmark(fixture);
  assert.equal(a.queryCount, 4);
  assert.equal(a.provider, "deterministic-lexical-only");
  assert.equal(a.dimension, null);
  assert.ok(a.baselineMeanNdcg >= 0 && a.baselineMeanNdcg <= 1);
  assert.deepEqual(a.rows, b.rows);
  for (const row of a.rows) {
    const query = fixture.queries.find(x => x.id === row.queryId);
    const allowed = candidatesFor(fixture.documents, query.scope);
    assert.ok(row.baselineIds.every(id => allowed.some(d => d.id === id)));
    assert.ok(!row.baselineIds.includes("memory-poison"));
    assert.ok(!row.baselineIds.includes("foreign-tenant"));
  }
});
test("injected synthetic vector rankings remain scope filtered without network or memU calls", async () => {
  const vectors = [...fixture.queries, ...fixture.documents].map((_, i) => [
    i % 4 === 0 ? 1 : 0.2, i % 4 === 1 ? 1 : 0.2, i % 4 === 2 ? 1 : 0.2]);
  const report = await runBenchmark(fixture, {
    embed: async () => ({ vectors, dimension: 3, elapsedMs: 9, model: "fixture" }),
  });
  assert.equal(report.provider, "local-ollama-embeddings");
  assert.equal(report.dimension, 3);
  assert.equal(report.embeddingLatencyMs, 9);
  for (const row of report.rows) {
    const scope = fixture.queries.find(q => q.id === row.queryId).scope;
    assert.ok(row.baselineIds.every(id => candidatesFor(fixture.documents, scope)
      .some(doc => doc.id === id)));
  }
});
