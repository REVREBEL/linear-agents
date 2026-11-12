# Intake, triage and incident work orders

Use for first classification of reported bugs, intake candidates, operational incidents or unknown ownership before implementation is authorized.

1. Verify report, reproduce safely if appropriate, gather environment and scope without assuming root cause.
2. Identify already existing capabilities/work orders, classify urgency, severity, affected users and candidate owner.
3. Form a bounded hypothesis, identify missing evidence and recommend the next authorized work order or route. Do not force a code change or destructive action during triage.
4. **PASS** requires a usable disposition and traceable evidence, not necessarily a corrected defect. **BLOCKED** if essential reproducibility data or access is missing.
5. Only create/change issues if requested and authorized; otherwise post findings on the originating issue.
