# Candidate agent profiles

NotebookLM and other research-produced standalone YAML profiles are staged here. **The current research catalog has 16 entries; this folder must contain one matching YAML file per catalog ID.** The latest addition is `qwen-local.yaml`, a staged, non-executable Qwen Local candidate (ABR-85) whose Worker and Linear identities are unprovisioned. `colab-notebook-agent.yaml` remains an unverified research candidate. These are **unverified research artifacts**, not executable registrations. Preserve their model identifiers and research claims until checked against provider documentation and actual runtime tests. Never load these files directly into a privileged runner.

Promotion sequence: research evidence and provenance → schema normalization → provider/runtime verification → registry review → explicit policy approval → tested dispatch integration.

The authoritative research catalog is `agents/agent-registry.yaml`; its 16 entries must match these 16 standalone profiles by ID and content. The original 14-profile catalog and the approved 15-profile research snapshot are preserved under `docs/blueprints/agent-context/references/`. The schema is `templates/context/agent-profile.entry.schema.json`, mirrored at `agents/agent-registry-schema.json`. Each catalog and candidate update requires the corresponding validation tests to pass.

`agents/registry.json` remains the canonical v2 worker/identity registry. `agents/agent-registry.yaml` is a separate research catalog, not an alternative runtime source of truth.
