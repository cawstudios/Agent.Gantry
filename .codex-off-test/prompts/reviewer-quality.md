# Quality Reviewer Subagent

Spawn the `quality-reviewer` custom subagent after deterministic verification passes.

The subagent must review only for:
- correctness
- regressions
- maintainability where it affects defect risk
- missing tests
- API and contract drift

The subagent must also review holistic architecture beyond the literal user request. Call out omitted provider boundaries, configuration ownership, onboarding, docs, tests, or operational impacts when they make the change incomplete or fragile.

Required output contract:
- score: 0-10
- blocking_findings
- non_blocking_findings
- residual_risks
- recommendation
- reviewed_scope

The parent session should wait for the subagent result, then record it with `record_review.py`.
