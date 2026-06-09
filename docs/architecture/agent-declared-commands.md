# Agent-Declared Commands

Status: proposed (design)
Owner: Boondi/runtime
Related: [capability-management.md](./capability-management.md), `application/guardrails/policy-registry.ts`

## Problem

Agent-specific slash commands currently leak into Gantry core. `/extract-leads-queries`
is hardcoded in `session/session-commands.ts`, carried as an `extractLeadQueries`
port on `GroupProcessingDeps`, implemented by `runtime/boondi-crm-manual-extraction.ts`
(a Boondi/CRM HTTP client living **inside** `apps/core`), and bound unconditionally
in `app/bootstrap/runtime-app.ts`. Every future agent command would pile into core
the same way, and core ends up speaking a specific agent's vocabulary (CRM, leads,
`BOONDI_CRM_*`).

Goal: a **generic core mechanism** where an agent's commands *and* their logic live
on the agent side, loaded by core exactly the way agent guardrail plugins are. Core
owns only the dispatch; it never gains agent-specific knowledge.

## Boundary: built-in vs agent commands

- **Built-in commands** — core-owned, fixed set (`/new`, `/status`, `/dream`,
  `/memory-status`, `/models`, `/model`, `/stop`, `/thinking`, `/commands`,
  `/digest-session`, `/extract-memory-facts`). These touch runtime internals
  (cursors, sessions, queue, memory) and stay hardcoded in `session-commands.ts`.
- **Agent commands** — declared *and* implemented on the agent side, loaded by core
  at boot. Their logic never enters core's source.
- **Resolution order**: built-in first. Built-ins are a reserved namespace — an agent
  command may not shadow one, and a collision is rejected at load time. A `/x` that is
  neither a built-in nor a loaded agent command returns "command does not exist."

## Loading model — mirror the guardrail policy registry

A new `command-registry` in core mirrors `application/guardrails/policy-registry.ts`:

- Dynamic `import()` of the agent's command module(s) from the agent's runtime folder,
  trying `<name>.ts` (dev) then `<name>.js` (prod), with the **same path-containment
  guard** (never load a file resolved outside the agent folder).
- **Structural validation** of each exported module shape `{ name, description,
  visibility, run }` (the analogue of `isGuardrailPolicy`). Invalid exports are
  logged and ignored, never crash the loader.
- Cached per agent folder.

Command modules are **self-contained** — types declared locally, no import dependency
on core's source layout — exactly like `agents/boondi_support/guardrails/guardrail.ts`.
Core validates the exported shape at load.

## Command module contract

```ts
// agents/<agent>/commands/extract-leads-queries.ts
export const command = {
  name: 'extract-leads-queries',     // slash word; kebab-case; must not collide with a built-in
  description: 'Extract CRM lead/query candidates from this conversation.',
  visibility: 'operator',            // 'operator' (default) | 'customer'
  timeoutMs: 60_000,                 // optional; core default applies otherwise
  ackOnStart: "On it — I'll confirm when it's done.", // optional; sent before run() for slow commands
  async run(ctx) {                   // ctx: { conversationId, conversationJid, phone?, threadId? }
    // DB / MCP / HTTP / LLM — whatever the command needs.
    // Keep thin where credentials live elsewhere (call the agent's backend, e.g. mcp-crm).
    return 'Lead/query extraction processed. Digests: 3 …'; // result string, relayed to the chat
  },
};
```

`run()` may do anything (DB, MCP, HTTP, LLM). The recommended shape keeps it **thin**
when the heavy work and credentials already live in a backend service (for Boondi,
`run()` calls `mcp-crm` rather than holding CRM DB credentials in core's process).

## Dispatch flow

1. `extractSessionCommand`: `/x` is not a built-in → look it up in the active agent's
   loaded registry → `{ kind: 'agent_command', name: 'x' }`.
2. **Auth**: `isSessionCommandAllowed` (operator `is_from_me` or control-allowlist),
   same gate as built-ins. `visibility: 'customer'` opts a command into
   customer-invokable; default is operator-only.
3. `handleAgentCommand`: optionally send `ackOnStart` (and set typing) → build the
   context envelope → invoke `run(ctx)` wrapped in a **timeout + try/catch** → relay
   the returned string via `sendMessage` → advance the cursor past the command message.
4. **Failure replies**: `run()` throws → `"/x failed: <sanitized>"`; timeout →
   `"/x timed out."`; not loaded → `"/x is unavailable in this runtime."`

## Runtime semantics (inherited from GroupQueue — documented, not built)

These follow from the existing per-conversation queue; the command feature gets them
for free:

- **Per-chat serialization.** A running command holds the chat's run (`state.active`).
  A message sent in the *same* chat while a command runs is flagged `pendingMessages`
  and processed *after* the command finishes (`drainGroup`) — never concurrent, never
  lost; multiple messages batch into the next run.
  (`group-queue.ts:216-220, 371, 492, 580-594`.)
- A queued message cannot be piped into a command run (a command has no agent process /
  `groupFolder`), so it falls back to the queue rather than interleaving.
- **Completion is notified, not silent.** Core awaits `run()` and sends its return as a
  WhatsApp message (the existing `group-processing.ts:165-258` pattern). For slow
  commands, `ackOnStart` covers the wait.

## Invariant: command-invokable ≠ agent-callable

The dispatcher invokes `run()` **operator-side**; it is independent of the agent LLM's
granted toolset. A command can trigger work the live agent itself cannot perform —
which preserves Boondi's "the live agent does no CRM writes" rule.

## Scalability

Throughput is governed by the agent backend's own pooling, not the command mechanism.
For Boondi, `mcp-crm` uses a shared `pg.Pool` (`max: 5`) created once at boot
(`packages/mcp-crm/src/db/pool.ts`, `server.ts:125`) and shared by the HTTP endpoints
and the digest watcher; a command **borrows** from it rather than opening connections.
`fetch()` to `mcp-crm` pools per origin via undici. A thin `run()` keeps exactly one
bounded pool in front of Postgres. Levers if a command ever gets hot: raise the pool
`max`, or make the backend endpoint enqueue-and-return.

## Ownership split

- **Core owns** (all agent-neutral, zero agent vocabulary): the `command-registry`
  (loader + structural validator + containment + cache), built-in/agent resolution and
  the reserved namespace, the auth gate, the dispatcher (ack + timeout + invoke + relay
  + cursor), and `/commands` help listing built-ins **plus** the active agent's commands.
- **Agent owns**: the command modules (declaration + `run()`) in its folder, and the
  heavy logic in its backend (e.g. `mcp-crm`).

## Boondi migration (the boundary fix and the proof)

- **Move** `apps/core/src/runtime/boondi-crm-manual-extraction.ts` →
  `agents/boondi_support/commands/extract-leads-queries.ts` as a self-contained command
  module. Its `run()` keeps the thin HTTP call to `mcp-crm`'s
  `/admin/extract-leads-queries`.
- **Delete from core**: the `extractLeadQueries` port on `group-processing-types.ts`
  and its wiring in `group-session-command-state.ts` and `group-processing.ts`; the
  import and binding in `runtime-app.ts` (lines 49, 575); the hardcoded
  `extract_leads_queries` branch in `session-commands.ts`,
  `session-manual-extraction-commands.ts`, and `session-command-help.ts`.
- **Keep** `/digest-session` and `/extract-memory-facts` as built-ins — memory is a
  genuine core concept; only the CRM command moves out.
- Net: core loses all CRM/Boondi vocabulary; Boondi gains a declared command loaded the
  same way as its guardrail.

## Decisions

1. **Visibility** — operator-only default; per-command opt-in `'customer'`. No command
   ships customer-visible in v1 (only the flag's plumbing exists).
2. **Discovery / activation** — explicit list (mirrors skills): `plugins.commands` in
   settings.yaml names which modules under `commands/` are active. The
   name/description/visibility/logic live *in the module* (cohesion preserved); the
   settings list only activates a module and keeps the capability-review gate, consistent
   with how `plugins.guardrail.file` and `plugins.skills` already work. Auto-discovering
   the whole folder was considered and rejected: it departs from the explicit-activation
   convention and skips the review gate.
3. **Timeout** — per-command `timeoutMs` with a core default (e.g. 60s).
4. **Slow-command UX** — optional `ackOnStart` string + typing indicator.

## Out of scope (v1)

- Transport adapters (MCP/HTTP) — `run()` calls whatever it needs directly; no separate
  command service or generic provider port.
- Enqueue-and-return for minutes-long, restart-durable jobs with pushed-back completion —
  only if a command outgrows the synchronous in-core model.
- A standalone `boondi-commands` service — extraction stays in `mcp-crm` until a
  non-CRM command justifies splitting.
