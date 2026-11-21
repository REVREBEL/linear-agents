# ABR-98 — Tool profile policy, source adapters and parity acceptance

**Status: source implementation and isolated tests, not a complete 30-tool replacement or an enabled production MCP host.** ABR-94/95 relay remains a two-tool read-only proof by default; ABR-96/97 executor/enrollment sources are still gated by real host policy and approved identity enrollment.

## Exact inventory and profile semantics

The unchanged, pinned [tool-parity.json](tool-parity.json) contains **30 connected Remote Desktop Commander tools, 42 BRC agent tools, 3 BRC relay tools, and 50 distinct names**. This document distinguishes that inventory from *implemented* and *approved* adapters. The 50-name matrix is a no-regression requirement, **not** a generated 50-tool catalogue that silently returns success.

The source-only `tool-profiles.mjs` uses three server-chosen profiles:

| Profile | Intended use | Discovered tools |
| --- | --- | --- |
| `core` | Minimum read-only exploration | Only registered, explicitly granted handlers from `list_devices`, `read_file`, `get_file_info`, `list_directory`, `get_config` |
| `focused` | Research/search/source browsing and interactive development | Core plus specifically registered search, Git, AST, terminal and job tools |
| `full` | Approved project-specific operations | All **actually registered** handlers allowed by verified tool+capability grants, except intrinsically rejected plugin and external transfer tools |

Handlers are injected by a **trusted host adapter**, never dynamically installed by a tool caller. Registration rejects unknown names, unsafe plugin/transfer names, privileged operations unless `allowAdmin` is explicitly enabled by the operator, and tools without reviewed strict input schemas. `tools/list` is a filtered view only. An exact-name call for a tool hidden from the profile is permitted *only* if its registered implementation and current OAuth scope, verified tool-session capability, device, workspace and optional privileged grants separately authorize execution. Wrong-device, revoked/expired, malformed and unknown calls fail closed. Tool arguments never mint session authority.

The optional `createLocalMcpRelay({ toolProfileBinding })` path requires **OAuth resource authorization** and a separately injected trusted `resolveVerifiedHandle` callback. The existing shared-bearer ABR-94/95 default continues unchanged. No production Bridge, Linear job, cloud ingress or existing host agent imports or activates the new gateway. OAuth scopes are independent: `mcp:discover`, `mcp:read`, `mcp:execute`, `mcp:write`, `mcp:document:write`, and `mcp:admin`. The resource metadata defaults to the original read-only scopes unless a separately approved IdP binding configures additional advertised scopes.

### Measured schema discovery (isolated representative fixture)

Run `npm run mcp:profiles:benchmark`. Benchmark uses **13 registered mock handlers with strict representative schemas**, not the full 30 connected golden runtime implementations. The timings measure synchronous in-process discovery; they are not remote-client/network SLAs.

| Profile | Registered fixture schemas | JSON bytes | Approx. tokens (chars / 4) | Representative discovery mean |
| --- | ---: | ---: | ---: | ---: |
| core | 5 | 1,517 | 380 | 0.0055 ms |
| focused | 11 | 4,045 | 1,012 | 0.00113 ms |
| full | 13 | 5,348 | 1,337 | 0.00101 ms |

Observed on the Ubuntu development host with Node v26.13.1, November 20, 2026. Timing and values should be regenerated after any schema changes; the benchmark tool prints actual values and explicitly labels mock handlers.

## Selected approved source handlers

**REPL/process:** `process-state.mjs` provides deterministic, bounded prompt classification for Python `>>> `/`... `, Pdb `(Pdb)`, MySQL/MariaDB and interactive shell prompts, including terminal ANSI stripping and completed/cancelled/timed-out states. `terminal-sessions.mjs` reuses this classifier while retaining ABR-96's arrival-ordered output segment cursor, nonblocking stdin and process cancellation. The existing executor's sandbox policy remains mandatory; this does not grant interactive execution to a remote web client.

**Git:** `git-readonly.mjs` exposes `git_status`, `git_diff`, `git_log` through the required ABR-96 sandbox runner, not the host shell. It injects reviewed, bounded structured arguments and disables external diff/optional locking/fsmonitor/hooks/pagers/global Git config. A separately verified scope checks each invocation. Outputs have their own byte cap, SHA-256, exit code and sanitized stderr. An offline Git fixture verifies status/diff/log and rejects path traversal.

**Structural source search:** `ast-structured.mjs` uses a pinned `@babel/parser@8.1.2` (MIT) JavaScript/TypeScript parser, a Linux-only safely pinned read handle, source SHA-256, node kind/symbol/line/column and bounded excerpts. `ast_rewrite` defaults to **dry-run**, emits a unified diff and leaves source bytes unchanged. A changing request needs explicit workspace-write authority, exact expected source hash, a uniquely selected structural declaration, valid replacement syntax, and a separately injected **approved atomic, dirfd-pinned collision-aware writer**. There is no production writer installed; authorized write tests use a controlled temporary fixture only. A source mutation without a production writer fails closed.

**PDF/document:** `pdf-offline.mjs` pins `pdf-lib@1.17.1` (MIT) and creates actual offline PDFs without Chrome, Puppeteer, runtime downloads or external URLs. It supports basic Markdown headings/paragraphs/bullets, fixed page sizing and pagination, and PDF page insert/delete from explicitly approved source bytes; page count, PDF format, SHA-256, preserve-original-on-failure and scoped write tests use disposable fixtures. The renderer labels its fidelity as `plain-markdown-subset`: it **does not promise full HTML/Markdown table layout, embedded media/font fidelity, arbitrary Unicode glyphs, PDF form preservation, DOCX conversion or macros**. The scoped `write_pdf` adapter requires `mcp:document:write` and a separately injected, reviewed atomic output writer; no live output path is enabled automatically. `read_pdf` was not one of the current 30 registered tools; it remains optional, not a fabricated preserved baseline. Excel/DOCX cell/paragraph/table tools require separate license, macro-safety and style-fidelity proof and are not exposed.

## PR #259 code review resolution

A Codex P2 and a Kilo critical finding independently identified invalid dry-run unified patches for sources with or without trailing newlines. The corrected AST diff tracks logical lines and final-newline state, emits the Git-compatible `\ No newline at end of file` marker, and no longer invents phantom EOF lines. Five real `git apply --check` and `git apply` round trips compare exact source/proposed bytes and SHA-256, including CRLF and unchanged EOF context. A separate review found ambiguous AST rewrites could be incorrectly authorized using `maxResults: 1`; rewrites now always search for two matches to identify ambiguity, with a no-write regression.

A Kilo warning about repeated JWT signature verification in `tools/list` was resolved by validating the signature once per HTTP request. The verified principal is tracked privately in the issuing OAuth resource authorizer and independently checked for each exact tool, scope, device, expiry and revocation. Forged proofs, exposed Set mutation, token-device restrictions and immediate revocation are tested. Git additionally uses `--literal-pathspecs` and rejects `@`/`+` selectors. The PDF tokenizer explicitly documents its limited supported constructs (headings 1–4, plain paragraphs, flat bullets) and unsupported code fences/tables/links/images/HTML/complex styles.

## Explicit tool parity gaps

These currently connected tool names **remain tracked but are not yet implemented as golden-compatible host adapters** in the new source gateway: `get_config`, `set_config_value`, `get_usage_stats`, `get_recent_tool_calls`, `get_tool_result`, `list_remote_tool_calls`, `who_am_i`, `get_file_info`, `read_multiple_files`, `list_directory`, `write_file`, `edit_block`, `move_file`, `create_directory`, `start_search`, `get_more_search_results`, `list_searches`, `stop_search`, `review_device_call` and `shutdown`. These **cannot be assumed operational** on the new gateway solely because their names exist in [tool-parity.json](tool-parity.json); the preexisting connected Desktop Commander plugin remains the behavioral reference. Likewise full BRC plugin/marketplace and third-party transfer facilities are not enabled. New tool-specific schema and exact byte/result parity still need golden fixtures, live handler adapters and two-host acceptance under ABR-98/100 before replacement.

The existing ABR-96 standalone terminal, cancellation and async job methods are already implemented in source, but their *full 30-tool compatibility surface*, signed host pairing and real Mac/Ubuntu production execution have **not** been switched on here. We refuse to advertise placeholder handlers that cannot honor behavior.

### Prohibited or privileged by default

`call_plugin_tool`, `list_plugin_tools`, `request_plugin_install`, `search_mcp_registry`, `prepare_file_transfer`, `send_file_transfer`, and `receive_file_transfer` are always excluded. No `tmpfiles.org` transfer channel or automatic marketplace install is included. `delete_file`, `set_config_value`, `review_device_call` and `shutdown` require explicit operator-approved admin scope and a reviewed handler (none installed). Neither name hiding nor tool argument aliases can bypass this policy. `write_pdf` requires a separate document-write capability from ordinary file writes.

## Verification and no-regression gates

- `npm run mcp:profiles:test`: pure profile/authorization and real OAuth relay integration, actual sandboxed Git, Babel AST reads/diffs and controlled atomic-writer fixture, offline PDF bytes/edit integrity, and deterministic REPL prompt fixtures
- `npm run mcp:foundation:test`, `mcp:oauth:test`, `mcp:executor:test`, `mcp:devices:test`, `bridge:test`, `test:reliability`: retained baseline, including ABR-96 cancel/reconnect/process-tree tests
- GitHub Actions `mcp-profiles.yml` is read-only and offline except locked package install; the runner installs temporary Bubblewrap and runs both ABR-98 Git/AST and strict ABR-96 interactive REPL/cancellation tests inside a test-only OS namespace; it cannot enroll real devices or start a production host
- Capture **real** `tools/list` and `tools/call` JSON input/result golden fixtures across all approved 30 connected tools, evaluate enhanced search/edit/PDF fidelity and both device platforms, then run ABR-100 end-to-end live client and safety gates before production promotion

## Rollback

Because the gateway is opt-in and unused by production, rolling back this branch removes only the source gateway/adapters/CI. Existing `agent-bridge.service`, macOS `io.revrebel.agent-bridge`, Linear OAuth/jobs, Synology NAS, PostgreSQL memory and Cloudflare remain unchanged. If a later approved adapter is enabled, revoke its tool/session/device grant and stop only its separately installed host unit; never replay interrupted writes.
