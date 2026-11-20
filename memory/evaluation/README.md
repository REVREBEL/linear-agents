# ABR-93 — Scoped synthetic recall evaluation (M1)

This is a **read-only, synthetic** local benchmark and model decision. It does not retrieve private memU content, install a reranker, create an index, alter Ollama/pgvector configuration, expose memory over MCP, or inject recalled text into an agent prompt.

## Verified Ubuntu baseline (November 19–20, 2026)

- Core memU CLI supports `retrieve`, `search`, `list-files`, `commit`; current bridge recall adapter is `memory/memu-memory.mjs`.
- Local Ollama includes `nomic-embed-text:latest`; bridge-owned memU config declares provider `openai` (OpenAI-compatible local Ollama endpoint) and embed model `nomic-embed-text`. No dedicated local cross-encoder reranker appears in `ollama list`.
- PostgreSQL on port 5433 stores memU in the `memu` schema. Installed pgvector version is **0.8.1**. Embedding columns are `vector` without a schema-level `vector(768)` typmod restriction. Existing records (one `recall_files`, one `recall_file_segments`, zero `resources`) show 768 dimensions; this is *not* a guarantee against future mixed dimensions.
- `recall_files`, `recall_file_segments`, and `resources` have B-tree scope and identity indexes, **not HNSW/IVFFlat vector indexes**. Tables have `user_id` and `agent_id`, but no dedicated `repository_id` or `issue_id` columns. Native memU retrieval does not enforce Bridge's four-field scope filter. The adapter therefore rejects records without independently attributed complete scope and keeps output out of prompts.
- Source documents and model versions may drift. Before any later production change, inventory actual model digest, embedding dimensionality across every row, per-record embedding provider/version metadata, and vector index requirements; backfill/reindex is **not** part of this PR.

## Reproducible local-only benchmark

`node --test memory/evaluation/recall-benchmark.test.mjs` checks scope isolation, required provenance/source SHA pin, invalid revisions, synthetic poison labels, scoring, deterministic ranking and bounded output.

`node memory/evaluation/recall-benchmark.mjs` runs a deterministic **lexical-only** fixture (no model call); `node memory/evaluation/recall-benchmark.mjs --ollama` submits **only the committed synthetic corpus** to the local loopback Ollama embeddings endpoint. Both emit JSON with ranked document IDs, per-query nDCG@3/MRR@3/precision@3, byte sizes, and process RSS. The runner cannot contact a remote endpoint and cannot mutate a database. The explicit synthetic `poisoned: true` flag tests rejection of a *known* bad example; it is **not** a production poison detector.

Fixture: 14 documents and four queries across two unrelated repository scopes, plus foreign tenant/agent/issue records, non-pinned content, one known poisoned sample, irrelevant and conflicting material. Relevance is manually assigned (0, 1 or 3) within a tiny test corpus. It tests the intended **admission/ordering contract**, not live memU's own ranker or repository-level database authorization.

### Observed results — synthetic local Ollama vectors

| Measurement | Result |
| --- | --- |
| Four query mean nDCG@3, vector cosine | **1.000** |
| Four query mean nDCG@3, token-overlap proxy | **0.9077** |
| Vector dimension | **768** |
| Embedding wall time (five warm repeated full-batch runs) | **241, 242, 242, 243, 245 ms** |
| Median / observed maximum (not a statistical p95) | **242 / 245 ms** |
| Benchmark process RSS across runs | **65.9–66.4 MiB** |
| Largest scoped top-three result envelope | **1,008 UTF-8 bytes** |
| Budget ceiling used in fixture | **2,500 UTF-8 bytes**, top **3** |
| Cross-scope or deliberately poisoned source in top results | **0** (fixture metadata filtered) |

The lexical comparison is **not** a cross-encoder. Its lower nDCG is not evidence that NVIDIA Nemotron Rerank VL, or any other untested model, would improve quality. The 768d model's local synthetic similarity is already perfect on this deliberately small corpus. Scores are uncalibrated; **no score threshold** is proposed.

## Decision and production gates

**Decision for review: retain local `nomic-embed-text` and the default-off recall adapter, reject enabling a reranker at this stage.** No new model, checkpoint change, indexing migration, threshold, prompt text or authorization surface is introduced.

The next stage, if separately approved, needs a larger labeled corpus with independently scoped/verified provenance; end-to-end measured memU native retrieval from disposable isolated storage; authenticated MCP parity only after remote memory support exists; disconnected-device, revision-invalidation and poisoned-tool-output tests; and a real **same-corpus**, licensed/approved reranker candidate with meaningful nDCG/MRR lift, bounded latency and resource usage, plus stable false-positive and isolation results. Require explicit operator activation after these acceptance checks. A test fixture's poison label cannot be used as runtime content security; untrusted memory must remain lower-trust evidence and cannot authorize commands, dispatch, Factory Brain changes or memU promotion.

Rollback: this evaluation is inert; remove the benchmark/test/doc entries. Running agents and memory storage are unchanged.
