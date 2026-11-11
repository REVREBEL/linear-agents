# Inventory, census and audit work orders

Use for discovery of files, skill packages, script inventories, provenance reconciliation, populations, or gap ledgers.

1. Define the exact target population, snapshot/time, exclusions and classification policy before counting. Record current source SHA when inventorying a Git tree.
2. Enumerate independently of historical summary counts; account for inaccessible/ambiguous entries without hiding them. Do not mutate source material as part of counting.
3. If the issue requires **complete** coverage, assert each in-scope path is represented exactly once or explicitly unresolved. Reconcile class totals and distinguish historical denominator populations.
4. For manifest/resource integrity audits, verify file existence and content hashes; for catalog graph audits, validate links and dependencies. These are **conditional**, not mandatory for an archive-title listing.
5. **PASS** requires the issue's declared coverage threshold, transparent unresolved set, repeatable collection methodology, complete traceability and exact deliverables; avoid treating unexpected system findings as an assessment failure when correctly reported.
6. Produce inventory tables, discrepancy and provenance ledgers only as specified by the issue. Use PR review if committed to repo; otherwise deliver and request Linear review.
