#!/usr/bin/env node
/** ABR-93 synthetic-only recall benchmark. No memU/DB writes or prompt injection. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const SHA = /^[0-9a-f]{40}$/;
const SCOPE = ["tenantId", "agentId", "repositoryId", "issueId"];
const MAX_INPUT = 40_000, MAX_RESULT = 2500, TOP_K = 3;
const words = text => new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) || []);
export function eligible(document, queryScope, expectedSourceSha = null) {
  return Boolean(document && queryScope && SCOPE.every(k =>
    typeof queryScope[k] === "string" && queryScope[k].length > 0 &&
    document.scope?.[k] === queryScope[k]) &&
    SHA.test(document.sourceGitSha || "") &&
    (expectedSourceSha === null || document.sourceGitSha === expectedSourceSha) &&
    Number.isSafeInteger(document.revision) &&
    document.revision > 0 && typeof document.sourcePath === "string" &&
    document.sourcePath.length > 0 && document.poisoned !== true &&
    typeof document.text === "string" && document.text.length > 0 &&
    document.text.length <= MAX_INPUT);
}
export function candidatesFor(documents, queryScope, expectedSourceSha = null) {
  if (!Array.isArray(documents)) throw Error("invalid corpus");
  if (expectedSourceSha !== null && !SHA.test(expectedSourceSha)) throw Error("invalid source pin");
  return documents.filter(doc => eligible(doc, queryScope, expectedSourceSha));
}
export function lexicalScore(query, document) {
  const q = words(query), d = words(document);
  if (!q.size || !d.size) return 0;
  return [...q].filter(token => d.has(token)).length / Math.sqrt(q.size * d.size);
}
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length)
    throw Error("embedding dimension mismatch");
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw Error("nonfinite embedding");
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function sorted(list, score) {
  return [...list].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
}
export function rankingMetrics(ids, relevant, k = TOP_K) {
  const gains = ids.slice(0, k).map(id => relevant[id] || 0);
  const ideal = Object.values(relevant).sort((a, b) => b - a).slice(0, k);
  const dcg = values => values.reduce((sum, grade, idx) =>
    sum + (2 ** grade - 1) / Math.log2(idx + 2), 0);
  const first = gains.findIndex(x => x > 0);
  return { ndcg: ideal.length ? dcg(gains) / dcg(ideal) : 1,
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
    precision: gains.filter(x => x > 0).length / k };
}
function emittedBytes(documents) {
  // Measurements are conservative proxies, NOT production token accounting.
  return Buffer.byteLength(documents.map(d =>
    JSON.stringify({ text: d.text, sourcePath: d.sourcePath,
      sourceGitSha: d.sourceGitSha, revision: d.revision, scope: d.scope })).join("\n"));
}
async function embedLocal(inputs, { model = "nomic-embed-text", timeoutMs = 30000 } = {}) {
  const start = performance.now(), controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("http://127.0.0.1:11434/api/embed", {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: inputs, truncate: false }),
    });
    if (!response.ok) throw Error("local embed HTTP " + response.status);
    const json = await response.json();
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== inputs.length)
      throw Error("invalid local embed output");
    const dimension = json.embeddings[0]?.length;
    if (!Number.isInteger(dimension) || dimension < 1 ||
      !json.embeddings.every(e => Array.isArray(e) && e.length === dimension))
      throw Error("embedding dimensions inconsistent");
    return { vectors: json.embeddings, dimension, elapsedMs: performance.now() - start };
  } finally { clearTimeout(timeout); }
}
const average = (list, prop) => list.reduce((sum, x) => sum + x[prop], 0) / list.length;
export async function runBenchmark(fixture, { embed = null } = {}) {
  if (fixture?.schemaVersion !== 1 || !Array.isArray(fixture.documents) ||
    !Array.isArray(fixture.queries) || !fixture.queries.length)
    throw Error("invalid benchmark fixture");
  const allTexts = [...fixture.queries.map(x => x.query), ...fixture.documents.map(x => x.text)];
  let embedding = null;
  if (embed) embedding = await embed(allTexts);
  const vectors = embedding?.vectors;
  const qCount = fixture.queries.length;
  const rows = [];
  for (let i = 0; i < qCount; i++) {
    const query = fixture.queries[i];
    if (!SHA.test(query.sourceGitSha || "")) throw Error("query missing pinned source SHA");
    const allowed = candidatesFor(fixture.documents, query.scope, query.sourceGitSha);
    // The vector list comes from the identical ordered synthetic corpus.
    const baseline = vectors ? sorted(allowed, doc => {
      const index = fixture.documents.indexOf(doc);
      return cosine(vectors[i], vectors[qCount + index]);
    }) : sorted(allowed, doc => lexicalScore(query.query, doc.text));
    // A lexical overlap pass is a lightweight *proxy comparator*, not a
    // cross-encoder or Nemotron evaluation; it never changes production recall.
    const lexical = sorted(allowed, doc => lexicalScore(query.query, doc.text));
    const top = baseline.slice(0, TOP_K), proxy = lexical.slice(0, TOP_K);
    rows.push({ queryId: query.id, allowed: allowed.length,
      expected: Object.keys(query.relevant),
      baselineIds: top.map(d => d.id), proxyIds: proxy.map(d => d.id),
      baseline: rankingMetrics(top.map(d => d.id), query.relevant),
      proxy: rankingMetrics(proxy.map(d => d.id), query.relevant),
      resultBytes: emittedBytes(top),
      exceeds2500ByteBudget: emittedBytes(top) > MAX_RESULT });
  }
  return { schemaVersion: 1, corpus: "synthetic", provider: vectors ? "local-ollama-embeddings" :
    "deterministic-lexical-only", model: vectors ? embedding.model || "nomic-embed-text" : null,
    dimension: embedding?.dimension || null,
    embeddingLatencyMs: embedding ? Math.round(embedding.elapsedMs) : null,
    // Actual RSS may include other processes; this is only benchmark process RSS.
    processRssBytes: process.memoryUsage().rss,
    topK: TOP_K, queryCount: rows.length,
    baselineMeanNdcg: average(rows.map(x => x.baseline), "ndcg"),
    proxyMeanNdcg: average(rows.map(x => x.proxy), "ndcg"),
    baselineMeanReciprocalRank: average(rows.map(x => x.baseline), "reciprocalRank"),
    maxResultBytes: Math.max(...rows.map(x => x.resultBytes)), rows };
}
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const local = process.argv.includes("--ollama");
  const fixture = JSON.parse(await readFile(new URL("./synthetic-recall.json", import.meta.url)));
  const result = await runBenchmark(fixture, { embed: local ? async inputs => {
    const output = await embedLocal(inputs);
    return { ...output, model: "nomic-embed-text" };
  } : null });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
