# Platform Roadmap Decisions — 2026-07-16

User decisions on the multi-tenant agent platform direction:

1. **KB/document ingestion per workspace — NEEDED.** First-class ingestion +
   retrieval for company docs/help centers (beyond `brain import` + memory).
   Future goal-prompt; sequenced after current cycles.
2. **Human handoff — NOT platform.** Built by whoever consumes Gantry as an
   SDK; the platform provides the primitives (interactions, tasks, events).
3. **Tenant isolation hardening — NEEDED.** Hostile-tenant review: one
   workspace's agent can never reach another's memory/credentials/
   conversations/egress identity. Verified via the E2E harness persona/
   topology matrix (see e2e plans).
4. **Blueprints + per-tenant evals — LATER.** Template instantiation via API
   and eval loops over observability traces; deferred.

## Agents-as-tools (approved direction)

Extend delegation so every registered agent can be exposed as a callable tool
to agents holding `AgentDelegation` (projection like skills/MCP — zero-code):
`delegate_task` gains a target-agent parameter; configured agents project as
named tools. Invariants: the callee runs under ITS OWN permission posture,
skills, MCP bindings, and memory scope (never the caller's — no authority
escalation through delegation); loop/depth guards; child permission prompts
route to the originating human conversation's approvers; per-hop trace
attribution (revisit ledger C.8 delegated-task span nesting, which becomes
required). Main agent = orchestrator, specialists = configured agents behaving
as durable, steerable subagents.
