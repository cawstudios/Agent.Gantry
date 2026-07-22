# Deferral Ledger

Deliberately-removed scope with explicit revisit triggers (`forge defer add`).
When a trigger fires, the item goes back on the roadmap and its row is
resolved: `./forge defer resolve <id> --notes "<what happened>"`.

| id | added | item | why deferred | trigger to revisit | status |
|----|-------|------|--------------|--------------------|--------|
| D-0001 | 2026-07-22 | Data retention for jobs/interactions/runtime events (split out of arch-quick-wins as cycle-sized) | Entangled with scheduler/lease/agent machinery; the promised ledger note never landed anywhere trackable | durable-work-primitive lane starts (it refactors the same jobs/interactions state) | open |
| D-0002 | 2026-07-22 | E2E persona/topology harness goal-prompt (re-draft) | goals-index referenced a scratchpad draft that did not survive; scope needs re-drafting from scratch | agent-e2e test-matrix reconciliation pass | open |
