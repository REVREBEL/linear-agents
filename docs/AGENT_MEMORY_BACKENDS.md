# LinearBridge short-term and long-term memory

## Scope

This branch extends the existing local bridge task checkpoints. It deliberately
does not change the GitHub-to-ChatGPT review notification flow.

### Short-term active task memory

- Existing `linear-jobs/active-task-memory` files remain the durable source of
  task recovery on the host running the bridge.
- Each Antigravity `step_update` emits a privacy-limited `AGY_BRIDGE_EVENT`
  containing its step number and tool name only. No commands, tool arguments,
  model text or secrets enter these progress markers.
- The bridge appends the most recent 20 milestones, with atomic writes and
  serialized concurrent updates.
- At the next same-issue assignment, the last six milestones are included in
  the non-authoritative recovery preamble. The agent must inspect actual code
  and tests.
- This helps survive model context resets, bridge restarts and new sessions.
  It **does not guarantee** uninterrupted continuation of an in-flight model
  session or compensate for missing checkpoints from unsupported hosts.
- The progress emitter currently covers Antigravity; Trae, Gemini and OpenCode
  need their own normalized stream adapters.

### Optional long-term memU recall

When `MEMU_RETRIEVAL_ENABLED=true`, the bridge calls `memu retrieve`
with a project-conventions query before issuing an agent job. It adds up
to 2,500 characters from at most five retrieval hits. It times out after
five seconds and fails open when memU is unavailable. The retrieved text is
labeled untrusted and never overrides code, tests, or the task ledger.

This is disabled by default until local memU is configured and tested.

### Promotion after completion

memU's current *developer* interface requires:

1. A faithful, completed **canonical session**, not synthesized issue history.
2. An independent evolve executor to process jobs in order.
3. A commit only after executor success.

The `scripts/memu-promote.mjs` adapter verifies a separate evidence file
and invokes `memu memorize prepare`. It returns the actual
`executor_prompt`, `jobs`, and `next_command`. It intentionally does not
run the evolve executor or automatically commit. Neither successful process
exit nor a GitHub comment is proof of verified completion.

Example evidence JSON:

```json
{
  "issueId": "SKIL-15",
  "review": { "status": "approved", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "tests": { "status": "passed", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
}
```

The proof must come from independently checked GitHub review and CI records
and must refer to the same head SHA. Do not produce this file merely because
an agent says its changes are correct.

Example commands, after installing/configuring memU:

```bash
node scripts/memu-promote.mjs private/session.json private/verification.json
# Send the returned executor_prompt to one agent with access to the memU
# workspace; execute every generated job serially.
# Only after successful execution:
memu memorize commit --json
```

The input session must use memU's canonical v1 JSON schema with actual
message/tool events. Never invent transcripts from a checkpoint.

### Server setup: PostgreSQL, pgvector and Ollama

The long-term server will use the existing PostgreSQL installation on
`rebel-server`; memU supports PostgreSQL through its optional extra.
Postgres alone does not provide pgvector. Check availability first:

```bash
sudo -u postgres psql -Atc "SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector';"
```

Install the extension package appropriate for the server's actual PostgreSQL
major version. In a dedicated, restricted memU database, enable it:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Keep credentials in service-managed environment or a private configuration
file, never in Git. For a local model-backed embedding endpoint:

```text
MEMU_MEMORY_MODE=local
MEMU_DB=postgresql://<restricted-role>@<host>:5432/<memory-db>
MEMU_EMBED_PROVIDER=openai
MEMU_BASE_URL=http://127.0.0.1:11434/v1
MEMU_EMBED_MODEL=nomic-embed-text
MEMU_API_KEY=local
```

`nomic-embed-text` is an example and must be pulled into Ollama before use.
Run the installed memU adapter's `doctor` and a real write/retrieve test
against the selected model and database. Never change an existing embedding
model without a planned reindex: mixed vector dimensions/index semantics can
break retrieval.

Local Ollama/OpenAI-compatible configuration is documented in memU's host
install guides. This branch does **not** install pgvector, change server
PostgreSQL, or validate connectivity from the Mac bridge.

### Next integration boundary

1. Move the exact task checkpoint backend to PostgreSQL through a
   versioned transactional store without changing the API contract.
2. Add normalized incremental checkpoints from Trae, Gemini and OpenCode.
3. Capture real session transcripts with secret scrubbing and source
   provenance; verify test/CI and PR head separately.
4. Enqueue only verified completed sessions for one serial memU evolve
   executor, then call `commit` and mark promotion successful.
5. Test a forced compaction/restart and verify retrieval of prior task state
   and reusable memU knowledge.

References:
- https://github.com/NevaMind-AI/memU/blob/main/README.md
- https://github.com/NevaMind-AI/memU/blob/main/docs/developer.md
- https://github.com/NevaMind-AI/memU/blob/main/src/memu/hosts/workbuddy/INSTALL.md
