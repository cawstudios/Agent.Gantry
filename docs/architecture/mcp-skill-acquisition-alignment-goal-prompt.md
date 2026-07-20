# MCP/skill acquisition alignment — goal prompt

Status: SCOPED via grill (2026-07-20) after a full code trace of the
agent-driven install→use loops (report embedded below via findings). Sequenced
AFTER the PR #237 validation verdict (`pr237-validation.md`) so fixes don't
collide or duplicate; e2e rows ride the lane per the test matrix.

## The product model (user-confirmed, unchanged)

Installs do NOT grant blanket tool permissions. Capabilities are curated mixes
of granular tools + MCP tools + skill tools with explicit read/write
separation. `request_mcp_server` binds INVENTORY-ONLY by design; durable action
requires a reviewed capability. This lane fixes the gaps AROUND that model —
it does not weaken it.

## Trace-confirmed defects and gaps (2026-07-20)

Code bugs:
1. **Second-server projection exclusion** — `authorizedMcpServerIdsForAgent`
   (`mcp-authorized-servers.ts:56-59`): once ANY `mcp__x__` tool rule is
   selected, servers without a matching rule (fresh inventory-only connects)
   are silently excluded from next-turn projection — bound but never
   materialized.
2. **Dead-end recovery guidance** — recovery strings instruct
   `request_mcp_server {...}` even where fixed-image/locked mode hides that
   tool (`tool-execution-policy-service.ts:542-562`).
3. **Deferred-collision failures** — skill materialization collisions surface
   at the NEXT spawn (whole spawn fails) after a success receipt
   (`claude-skill-materializer.ts:189-203`).

Design gaps (locked decisions below address):
4. Same-turn availability over-promise ("available now" is only true for the
   inlined body / gantry-proxy path; SDK surfaces are spawn-frozen).
5. Multi-skill installs inline only the FIRST skill in-turn
   (`ipc-skill-install-handlers.ts:284-290`).
6. Reconcile-replace drops agent-installed bindings
   (`desired-state-capability-reconcile.ts:83-107`); inactive-server rows fail
   whole reconciles (`:313-320`).
7. No runtime tool discovery — agents can't search MCP tools.

Fragility (watch, don't rebuild): bind+sync coupling rolls back working
installs on sync failure (hardened by UX Stage A; re-breakable).

## Locked decisions (grill, 2026-07-20)

1. **FTS tool search now, semantic-ready interface.** One `mcp_search_tools`
   surface over tool names+descriptions+server (Postgres tsvector or
   in-memory; zero new infra). Semantic search plugs into the SAME interface
   later via the existing embedding layer IF a real miss-rate appears. No
   embeddings now (YAGNI at dozens-to-hundreds of tools).
2. **Honest receipts, no mid-run refresh.** Receipts state exactly what is
   usable NOW (inlined skill bodies; MCP via gantry proxy `mcp_call_tool`)
   vs NEXT turn (SDK-registered skill, direct `mcp__` tools — the access
   fingerprint already forces the respawn). Mid-run re-materialization stays
   unbuilt.
3. **Reconcile preserves agent-installed bindings.** Reconcile merges instead
   of blind-replace for `agent_request`-created active bindings: they survive
   unless the revision EXPLICITLY removes them. Inactive-server rows warn+skip
   instead of failing the whole reconcile.
4. **Inline ALL installed skills up to the byte budget** (existing
   `SAME_SESSION_SKILL_CONTEXT_MAX_BYTES` cap), with an honest "N more
   available next turn" line when truncated.

## Also in scope (from the trace's code-bug list)

- Fix defect 1 (projection exclusion): inventory-only bound servers must
  project next turn regardless of existing `mcp__` rule selections (they are
  discoverable inventory; action authorization stays capability-gated).
- Fix defect 2: recovery guidance must be mode-aware — locked/fixed-image
  agents get the honest "provision before the run" phrasing, never a hidden
  tool name.
- Fix defect 3: validate materialization collisions AT INSTALL TIME (name
  collision against currently-selected skills → fail the install receipt
  honestly, not the next spawn).

## E2E rows (ride this lane; add to agent-e2e-test-matrix.md as built)

- Integration: projection includes inventory-only server alongside selected
  `mcp__` rules; reconcile preserves agent-installed binding vs explicit
  removal; install-time collision rejection; mode-aware recovery strings.
- E2e (haiku, once Stage C harness lands): the agent-driven acquisition rows
  already in the matrix (§4/§5) — request → approve → next-turn use; plus
  `mcp_search_tools` used by the agent to find and then call a fixture tool.

## Non-goals

- No blanket permissions on install (the capability model stands).
- No semantic embeddings for tools in v1.
- No mid-run SDK session mutation.
- No changes to the reviewed-capability approval flow itself.

## Sequencing

After `pr237-validation.md` lands its verdict: fold #237's overlapping fixes
in (or rebase this lane's scope down to what #237 doesn't cover). Implementer:
Fable subagents (user directive), one worktree, matrix rows flipped with
citations at closeout.
