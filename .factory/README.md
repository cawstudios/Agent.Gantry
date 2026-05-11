# `.factory/` — Factory Run Artifacts

This directory is the **runtime journal** of the Codex agent harness. The
harness in [`.codex/`](../.codex/README.md) writes structured artifacts here as
a factory run progresses; gates read those artifacts to decide whether the run
is PR-ready.

If you are new: read [`.codex/README.md`](../.codex/README.md) first. This
README explains the artifacts themselves.

---

## 1. What Lives Here

```
.factory/
├── README.md                  # tracked: this file
├── run.json                   # active run state (single source of truth)
├── decomposition.json         # task graph from docs-decomposer
├── plan.md                    # current plan reference (markdown form)
├── verify.json                # last deterministic verify run
├── tests.json                 # automated + functional test reports
├── reviews/
│   ├── quality.json
│   ├── performance.json
│   └── security.json
├── validation-report.json     # output of validate_artifacts.py / validate_work.py
└── decomposition.LOCAL-*.json # archived decompositions from prior runs (optional)
```

**Tracked in git:** only `README.md`. Everything else is generated and
.gitignored — see top-level `AGENTS.md`:

> Do not track generated run/hook artifacts: `__pycache__`, `*.pyc`, coverage,
> validation reports, active `.factory/`, or tarballs.

Do not commit generated `.factory/*.json` files. They are local state.

---

## 2. The Single Source Of Truth: `run.json`

Created by `python3 .codex/scripts/intake.py`, mutated by `update_run.py` and
the `record_*` scripts. Every agent reads it before doing anything.

```jsonc
{
  "issue_key": "LOCAL-35",
  "title": "Runtime refactor execution",
  "tracker": "linear",
  "branch": "feat/LOCAL-35-runtime-refactor-execution",
  "phase": "done",                 // planning | decomposing | awaiting-approval |
                                   // implementing | testing | reviewing |
                                   // functional-check | pr-ready | done | blocked
  "plan_status": "approved",       // needs-plan | awaiting-approval | approved
  "decomposition_status": "recorded",
  "implementation_status": "pending",
  "tests_status": "passed",        // pending | recorded | passed | failed
  "verify_status": "passed",
  "review_status": "passed",
  "created_at": "...",
  "updated_at": "...",
  "pr_url": "https://github.com/..."
}
```

Rule: **never hand-edit `run.json`**. Use:

```bash
python3 .codex/scripts/update_run.py --phase reviewing
python3 .codex/scripts/update_run.py --plan-status approved
```

---

## 3. Artifact Contracts

Each artifact has a strict schema enforced in `.codex/scripts/factory_gates.py`.
The recorder scripts coerce input fields and timestamp them.

### `decomposition.json`

Written by `record_decomposition_from_json.py` from `docs-decomposer`. Must
include `tasks: [...]` (non-empty); typically also `project`, `doc_roots`,
`epics`, `build_waves`, `linear_plan`, and a `surface_impact_matrix` per
top-level `AGENTS.md`.

### `verify.json`

Written by `verify.py`. Records the deterministic verification chain in order:
`structural → build → architecture → runtime-truth → factory-python-tests →
typecheck → tests → e2e`. Gate requires `ok: true` and non-empty `results`.

### `tests.json`

Written by `record_test_from_json.py` for both `automated` and `functional`:

```jsonc
{
  "automated": {
    "status": "passed",                  // passed | failed | partial
    "summary": "...",
    "tests_added_or_updated": [...],
    "commands_run": [...],
    "pass_fail_summary": "...",
    "blocking_findings": [],             // gate fails if non-empty
    "remaining_gaps": [...],
    "reviewed_scope": [...]
  },
  "functional": {
    "status": "passed",
    "score": 9,                          // gate requires >= 8
    "summary": "...",
    "manual_validation_steps": [...],
    "blocking_findings": [],
    "non_blocking_findings": [...],
    "residual_risks": [...],
    "recommendation": "approve",         // approve | approve-with-caveats | changes-required
    "reviewed_scope": [...]
  }
}
```

### `reviews/{quality,performance,security}.json`

One file per reviewer subagent, written by `record_review_from_json.py`. All
three are required; gate enforces `score >= 8`, no `blocking_findings`, and a
valid `recommendation`.

```jsonc
{
  "aspect": "quality",
  "score": 9,
  "summary": "...",
  "blocking_findings": [],
  "non_blocking_findings": [...],
  "residual_risks": [...],
  "recommendation": "approve",
  "reviewed_scope": [...],
  "recorded_at": "..."
}
```

Reviewers also include domain-specific fields (e.g. `attack_path_or_boundary`
for security, `whether_measured_or_inferred` for performance) — see the
prompts under `.codex/prompts/reviewer-*.md`.

### `validation-report.json`

Written by `validate_artifacts.py` and `validate_work.py`. Aggregates the gate
evaluation plus the verify/pr-ready step results. Useful when a gate fails and
you want a single file to inspect.

## 4. The PR-Ready Gate

`pr_ready.py` (called by `validate_work.py`) refuses to mark a run PR-ready
unless **all** of the following hold:

- `run.plan_status == "approved"`
- `run.decomposition_status == "recorded"`
- `decomposition.json` exists with at least one task
- `verify.json.ok == true` with non-empty `results`
- `tests.json.automated` valid, no blockers, status not `failed`
- `tests.json.functional` valid, score ≥ 8, no blockers
- `reviews/quality.json`, `reviews/performance.json`, `reviews/security.json`
  all present, score ≥ 8 each, no blockers, recommendation in the allowed set

Failure modes are listed line-by-line in the printed report. Fix the
underlying artifact, re-record, then re-run the gate.

---

## 5. Typical Lifecycle

```bash
# 1. Bootstrap
python3 .codex/scripts/intake.py --issue ENG-123 --title "Add X capability"

# 2. Plan (planner-high) — write the plan, get human approval
python3 .codex/scripts/update_run.py --plan-status approved --phase decomposing

# 3. Decompose (docs-decomposer) — emits JSON
python3 .codex/scripts/record_decomposition_from_json.py --input /tmp/decomposition.json

# 4. Implement the leaf task, then move to testing
python3 .codex/scripts/update_run.py --phase testing

# 5. Automated tests + verify
python3 .codex/scripts/record_test_from_json.py --kind automated --input /tmp/automated-test.json
python3 .codex/scripts/verify.py
python3 .codex/scripts/update_run.py --phase reviewing

# 6. Parallel quality / performance / security reviews
python3 .codex/scripts/record_review_from_json.py --aspect quality     --input /tmp/quality.json
python3 .codex/scripts/record_review_from_json.py --aspect performance --input /tmp/performance.json
python3 .codex/scripts/record_review_from_json.py --aspect security    --input /tmp/security.json
python3 .codex/scripts/update_run.py --phase functional-check

# 7. Functional check
python3 .codex/scripts/record_test_from_json.py --kind functional --input /tmp/functional-test.json

# 8. PR-ready
python3 .codex/scripts/validate_work.py
python3 .codex/scripts/pr_ready.py
```

`stage_orchestrator.py` prints exactly the next set of commands for the
current phase — when in doubt, run it.

---

## 6. Cleanup & Hygiene

- One active run per branch. Starting a new `intake.py` overwrites
  `run.json`; archive the previous decomposition if you want to keep it
  (`decomposition.LOCAL-*.json` in this folder are old archives — keep or
  delete as you like, they are not read by the gates).
- If gates fail because an artifact is stale, **re-record** it; never edit
  the JSON by hand. Recording stamps `recorded_at` and updates `run.json`
  consistently.
- Don't commit anything in this directory except `README.md`.
