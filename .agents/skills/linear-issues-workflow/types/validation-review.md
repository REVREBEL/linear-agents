# Testing, validation and review work orders

Use for test execution, CI baselines, independent reviews, security/static analysis, negative-path checks and compliance evidence. **For code review, load and follow the repository's code-reviewer skill in addition to this guide**.

1. State target revision/SHA, expected behaviors, test environment, actual scope and test inventory; separate pre-existing failures from new observations.
2. Run safe applicable tests, static checks and negative cases; log commands, versions, exit codes and skipped/blocked checks. Never run unsafe side-effecting operations to obtain a green badge.
3. Report product/system technical **PASS/FAIL** separately from whether the review/assessment itself was complete. Do not patch bugs unless separately authorized.
4. A report needs evidence-linked findings, severity/impact where appropriate, reproducibility details, test coverage gaps and recommendations.
5. Reference closure applies only when testing references/routers; hashing only when validating manifests; repeated byte-equivalence only if determinism is part of acceptance.
6. Handoff evidence via issue comment or PR depending on the issue's actual deliverable.
