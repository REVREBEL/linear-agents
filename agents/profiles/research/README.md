# NotebookLM research handoff

Research may propose model profiles, capability comparisons, adapter designs, and citations. Capture notebook/source identifiers, observation date, provider model ID, endpoint, modalities, context/output limits, tool-calling support, pricing/availability, and confidence or unknowns. Avoid embedding credentials or session data.

The bridge must independently check installed CLIs, reachable providers, actual model responses, allowed tools, dispatch host, and authorization before marking an agent operational. Track `researched`, `configured`, and `verified` separately; do not equate a NotebookLM answer with an agent heartbeat.

Reviewed provider adapters belong under `integrations/`; durable review handoffs belong under `jobs/`; runtime memory belongs under `memory/`. No automatic promotion from NotebookLM into the dispatch registry.
