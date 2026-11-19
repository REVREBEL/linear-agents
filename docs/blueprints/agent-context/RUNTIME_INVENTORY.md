# ABR-63 — Reconciled Ubuntu harness inventory (staged only)

**Status:** Git-reviewed proposed host snapshot; no runtime activation or service restart. The source of truth for executable **Linear agents** remains `agents/registry.json`; this separate host snapshot contains *CLI harness installation metadata only*.

## Source and provenance

- **Reviewed input:** `templates/context/agent-runtimes.staged.json`.
- **Deterministic renderer, checker and guarded installer:** `scripts/reconcile-agent-runtimes.py`.
- **Host destination:** `/opt/agents/registry/agent-runtimes.json`.
- **Existing historical creator:** `origin/infrastructure:scripts/15-stage-agent-runtime-registry.sh`. That script wrote the old values once; it is not an active synchronization source.
- **Ownership:** Git reviews changes to the intended host snapshot. A deliberate authorized `--apply` operation installs it on Ubuntu, atomically replacing the staged host copy and preserving a timestamped backup. The host copy is never imported into the executable Bridge Registry v2 or used to infer dispatch permissions.

## Evidence from the Ubuntu host (November 18, 2026)

| Harness | Existing staged command / classification | Verified installed path / version | Intended staged command |
| --- | --- | --- | --- |
| OpenCode | `/opt/agent-tools/bin/opencode` / native | Present, executable, **1.19.5** | Unchanged |
| Gemini | `/opt/volta/bin/gemini` / Volta | `/opt/global-tools/volta/bin/gemini`, **0.68.0** | Correct to installed shim |
| Kilo | `/opt/volta/bin/kilo` / Volta | `/opt/global-tools/volta/bin/kilo`, **7.8.27** | Correct to installed shim |
| Codex | `null` / `not-installed` | `/opt/global-tools/volta/bin/codex`, **0.169.0** | Record installed Volta shim, retain `requires-adapter` |

The staged `defaultNodeHome` incorrectly points to `/opt/volta`; the installed root is `/opt/global-tools/volta`. `/opt/agent-tools/bin/agent-exec` exists but contains **separate stale exports** to `/opt/volta`, `/opt/uv` and `/opt/bun`. The shared launcher/permissions repair is tracked in [ABR-54](https://linear.app/revrebel/issue/ABR-54/codex-ubuntu-repair-shared-opt-agent-runtime-and-verify-linear-agent). Do not mistake a resolved snapshot path for a healthy launcher or valid per-user Codex login.

The OpenCode `opencode-central.service` service was **inactive** at inspection. Its name is preserved as descriptive metadata; this snapshot does not enable or start that service.

Native user profiles live in `/opt/agents/<name>/`. A profile directory may exist without an executable (e.g. Qwen or Mistral Vibe). **Qwen Local** is a *model served through OpenCode*, not evidence that the native `qwen` CLI is installed; no new harness entries were invented in this reconciliation.

## Supported workflow

Run from the **reviewed Git checkout**, on the intended Ubuntu host:

| Operation | Command |
| --- | --- |
| Validate the Git source | `python3 scripts/reconcile-agent-runtimes.py --validate` |
| Inspect installed paths (read-only) | `python3 scripts/reconcile-agent-runtimes.py --probe` |
| Compare host snapshot with Git source (read-only) | `python3 scripts/reconcile-agent-runtimes.py --check` |
| Print the proposed snapshot | `python3 scripts/reconcile-agent-runtimes.py --render` |
| Install after merging reviewed source, with existing host-file write permissions | `python3 scripts/reconcile-agent-runtimes.py --apply` |
| Confirm installed metadata matches reviewed source | `python3 scripts/reconcile-agent-runtimes.py --check` |

`--apply` only operates on a pre-existing, `schemaVersion: 1`, `staged-not-integrated` file whose entries all have `enabledForDispatch: false`. It refuses symlink targets and enabled dispatch entries; creates a timestamped backup; preserves file mode/ownership; and atomically replaces the staged JSON. The command never installs CLIs, creates Worker identities, changes private native profiles, enables dispatch, or restarts services. Its `--probe` verifies path existence and executability, not CLI login, model responsiveness, adapter readiness or active service status.

The check should initially report drift while the host retains the historical snapshot; it is expected to pass after an authorized post-merge `--apply`.

## Boundaries and next work

- **ABR-54** owns repairs to `/opt/agent-tools/bin/agent-exec`, user-specific CLI permissions and real Codex execution.
- **ABR-64** owns research-profile → executable agent promotion; the staged harness manifest is not an input to automatic promotion.
- **ABR-69** owns host-root README frontmatter and documentation rollout.
- **ABR-73–76** own the `agent-context` resolver, not this inventory reconciler.

Tests: `python3 scripts/test_reconcile_agent_runtimes.py`. CI runs them when either source, reconciler, tests or Agent Context blueprint changes.
