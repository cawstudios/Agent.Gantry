# Pillar 2 — Warm Worker Pool (Design Spec)

- **Status:** DRAFT for deep review. Not approved. No code until sign-off.
- **Date:** 2026-06-15
- **Scope:** Remove the ~2 s cold `startup` (Node-runner spawn + Claude-CLI boot + MCP connect) from the **first reply of a conversation** by serving it from a **pre-warmed worker** — making the first message behave like today's warm continuation (no `startup` row).
- **Pooling model:** **Model A** — pre-warm → bind one customer → use once → recycle (destroy + replace). No cross-customer reuse. (Operator decision 2026-06-15.)
- **Priority:** per-conversation cold-start now; fast-at-scale later. Built concurrency-ready, but the pool *manager* ships, not a scale policy.
- **Dependency:** the per-customer **late-bind** rides **Pillar 1's** two-phase socket handshake. The SDK-capability spike + boot-generic restructure + pool manager are **independent of Pillar 1** and can be built in parallel (see §16).
- **Non-goals:** Pillar 1 (transport), Pillar 3 (dropped), model/LLM/Shopify optimization, Model B (reuse-across-customers).
- **Acceptance:** identical to Pillar 1 — the Boondi E2E runbook (`docs/BOONDI-E2E-TESTING.md`), behaving exactly as today, proven in the admin panel; flag default-off; pool-on adds the latency win with no behavioral delta (§17).

> Terminology: **worker** = the runner child process + its Claude CLI subprocess + gantry-MCP subprocess (the 3-process tree). **Boot-generic** = a worker started with only agent-level (shared) config and **no customer identity**. **Bind** = attaching one customer's identity + first message to a generic worker at assignment.

---

## 1. Goals & success criteria

### 1.1 Latency
Measured baseline (admin trace + `gantry.message_traces`): the cold first reply carries a **`startup` ≈ 2.0 s** span. Pillar 2 removes it.

| Section | cold today | after Pillar 2 (+ Pillar 1) | mechanism |
|---|---|---|---|
| `startup` (cold spawn) | ~2.0 s | **~0** (paid before the customer messages) | first message served from a pre-warmed worker → no `startup` row, like a warm continuation |
| first LLM `providerWaitMs` detail | ~1.8 s (incl. cold cache **write** 6,384 tok) | **shorter** (cache **read**, not write) | prompt-cache warmth: shared Boondi prefix kept hot (§8) |

Net: the cold first reply (~8.3 s today) drops toward a warm reply (~4 s with Pillar 1's gap removal), the remainder being model + tool time (the LLM / Shopify — out of scope).

### 1.2 Behavioral equivalence (hard gate)
Same as Pillar 1: at the user level Boondi behaves **identically**. Flag defaults off (no pool). With the pool on, the only observable change is the first reply is faster and its trace has no `startup` span. Proven by §17 (the E2E runbook under both states).

### 1.3 Concurrency-ready, not concurrency-now
The pool *mechanism* (pre-warm N, acquire, recycle, replenish, health, backpressure) ships. Sizing/fairness *policy* for 100s concurrent is deferred. At pool size 1 it's "keep one warm spare"; the interface is identical at size 50.

### 1.4 Provider-neutral
Warm-pool is an **optional capability** behind `AgentExecutionAdapter` (§13). The Anthropic-CLI adapter implements it; an in-process direct-API adapter omits it and the core falls back to cold `prepare()`-per-conversation. (Per Pillar 1 §4.4.)

---

## 2. Background — the cold start, and what's shared vs per-customer

### 2.1 The 3-process tree (each gets customer identity via env at its own spawn)
```
core spawnAgent ─env→ runner child ─query()→ Claude CLI subprocess ─spawn(env)→ gantry-MCP stdio
                                                      └─http/sse connect→ boondi-crm / shopify (signed caller-identity header)
```
The cold ~2 s = runner spawn + CLI boot + MCP connect → first SDK message (`firstSdkMessageAt`, set once per process at `query-loop.ts:393-395`).

### 2.2 The decisive split (source: bound-state inventory)
**SHARED across all customers of an agent → a generic worker CAN boot with these:** cwd (`GANTRY_WORKSPACE_GROUP_DIR` = per-agent folder, `agent-spawn.ts:577`), model, **compiled system-prompt prefix** (cache-keyed `appId::agentId::persona`, `agent-spawn.ts:317`, `prompt-cache.ts`), persona, capability/tool profile + MCP server set, `GANTRY_IPC_DIR` (folder-scoped), `GANTRY_IPC_AUTH_TOKEN` (scope = folder/app/agent/thread — **no chatJid**, `ipc-auth.ts:17-30`), MCP signing secret (`mcp-secret-projection.ts:51`), model OAuth creds (shared account).

**PER-CUSTOMER → must late-bind at assignment:**
| Item | source / file:line | delivered today via | difficulty |
|---|---|---|---|
| `memoryContextBlock` | `query-loop.ts:186-187`, `message-stream.ts:22-31` | **already the FIRST user message** (not the prompt) | **easy** ✅ |
| `guardrailSystemPromptAppend` | `system-prompt.ts:53-62` | concatenated into system-prompt append at boot | **small** — move to per-turn preface |
| SDK `resume` session handle | `query-loop.ts:332-335` | `query()` option | **hard** — boot-time option (§6.4) |
| bind channel | `runner/bind-channel.ts` | socket-delivered bind payload | **done** — set at bind |
| `GANTRY_MEMORY_IPC_AUTH_TOKEN` | `ipc-auth.ts:115-138` (chatJid in HMAC scope) | spawn env (runner + MCP child) | **moderate** — recompute per customer, deliver to both |
| MCP caller-identity signed header (`phone;ts;sig`) | `mcp-caller-identity.ts:95-126`, frozen in config file `agent-spawn-mcp-config.ts` | static file read at connect | **hard** — re-sign at bind (fresh `ts`); live connection swap or per-call facade |
| **gantry-MCP child customer env** (`GANTRY_CHAT_JID`, thread, memoryUserId) | `agent-capabilities.ts:220-226`, read as constant `context.ts:53`, stamped per outbound `messaging.ts:204` | env at MCP-child spawn, **no per-call rebind** | **hardest (structural)** — §7.2 |
| run handle, egress principal | `agent-spawn.ts:256,537` | per-spawn | **moderate** — fresh per bind |
| response signing keypair lifetime | `agent-spawn.ts:453,773` | per-spawn, revoked at run end | **lifecycle** — widen to per-worker (§7.3) |

### 2.3 Two cache-prefix perturbers to neutralize (so the shared prefix is byte-identical across customers)
1. The durable-memory **boundary policy** is included only when the customer has a memory block (`memory-boundary.ts:18-27`, gated on `Boolean(memoryBlock)`) → **fix: make it unconditional** so the prefix never varies.
2. `guardrailSystemPromptAppend` is concatenated into the append → **fix: move it to a per-turn user-message preface.**
Both are appended *after* the static prefix (`system-prompt.ts:53-60`), and the SDK already strips per-user dynamic sections (`excludeDynamicSections:true`, `system-prompt.ts:23-31`) — so with these two moved, the cached prefix is fully shared.

---

## 3. The enabling finding — the SDK natively supports Model A

The Claude Agent SDK exposes a **purpose-built warm primitive** (source: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):

- **`startup({ options, initializeTimeoutMs? })`** (`sdk.d.ts:5676`) — *"Pre-warms the CLI subprocess so the first `query()` resolves immediately."* Returns a **`WarmQuery`** (`sdk.d.ts:5933`): *"The subprocess has already been spawned and completed its initialize handshake."*
- **`WarmQuery.query(prompt)`** (`sdk.d.ts:5938`) — attaches a streamed `AsyncIterable<SDKUserMessage>` to the ready process with **no startup latency**. **Single-use** ("Can only be called once per WarmQuery").

Single-use is not a limitation for us — it **is Model A**: pre-warm a handle, hand it to one customer, recycle, re-warm a replacement. (Model B / one process serving many customers is *not* supported via `startup()`, which is fine — we rejected Model B.)

Supporting SDK facts:
- **Generic boot:** omit `resume`/`continue`/`sessionId` → fresh session (`sdk.d.ts:1695/1320/1701`); `systemPrompt` supports the "cacheable prompt for multi-user fleets" layout (`sdk.d.ts:1900-1914`); `mcpServers` connect once at startup, `alwaysLoad:true` forces pre-turn-1 connect (`sdk.d.ts:1010/1120/1136`).
- **Customer attach:** push the per-customer context block + first message as `SDKUserMessage`s on the stream (`shouldQuery:false` seeds context without a turn — `sdk.d.ts:3753`). This is exactly Gantry's existing `MessageStream`/`pushContent` pattern (`message-stream.ts`, `query-loop.ts:187/207`) — no system-role streamed message exists, so per-customer context rides as a `user` message.

**Implication:** the spike (the gate) is testing a sanctioned SDK path, not fighting the SDK. The residual risk is Gantry-side: the per-customer identity that's env-baked in the **gantry-MCP child** and the **MCP caller-identity header** (§7).

---

## 4. Design principles
1. **Boot generic, bind late.** A worker boots with only shared agent config; all customer identity arrives at assignment.
2. **Use-once + recycle (Model A).** A bound worker serves exactly one conversation, then is destroyed and replaced — no cross-customer reuse, so cross-customer state bleed is structurally impossible.
3. **Reuse the SDK primitive.** `startup()`/`WarmQuery` is the warm mechanism; don't hand-roll process pre-spawning.
4. **One integration seam.** Substitute "acquire warm worker" for "spawn cold child" at exactly one place (`executeRunnerProcess`), preserving every downstream contract.
5. **Behavioral equivalence + default-off** (Pillar 1 §1.5 rules apply verbatim).
6. **Provider-neutral optional capability** (Pillar 1 §4.4).

---

## 5. Target architecture

### 5.1 Warm pool manager (neutral core, NEW)
A new neutral component (modeled on `GroupQueue`'s lifecycle discipline) that owns: a set of pre-warmed workers per `(providerId, agentKey)`, with verbs `prewarm(n)`, `acquire(scope) → worker | null`, `release(worker)` (= destroy + schedule replacement for Model A), `health-check`, `evictIdle`, `size/replenish`. Knows nothing about `query()`/MCP — it drives the adapter capability (§5.2). Bounded; default size small (1–2); flag-gated (`GANTRY_WARM_POOL`, default off).

### 5.2 Optional adapter capability `WarmPoolCapable` (NEW, extends `AgentExecutionAdapter`)
```
interface WarmPoolCapable {
  prewarm(shared: SharedBootRecipe): Promise<WarmWorkerHandle>;   // boot generic
  bind(handle: WarmWorkerHandle, scope: ConversationBindScope):    // late-bind identity + deliver
       Promise<BoundRun>;                                          // returns the same handle shape spawnAgent uses
  recycle(handle: WarmWorkerHandle): Promise<void>;                // destroy
  prewarmCaches?(handle: WarmWorkerHandle): Promise<void>;         // optional model-cache warm (§8)
}
```
`SharedBootRecipe` = the SHARED subset (§2.2). `ConversationBindScope` = the PER-CUSTOMER set (§2.2), neutral fields only (chatJid/thread/app/agent/session/memoryBlock/run-handle). Adapters that can't pool simply don't implement `WarmPoolCapable`; the pool manager treats them as "no pool → cold spawn."

### 5.3 Anthropic adapter implementation
- `prewarm` → `startup({ options: { systemPrompt: <shared prefix>, mcpServers: <shared set, alwaysLoad>, persistSession, cwd: <agent folder> } })` → holds the `WarmQuery` + the booted runner/CLI/MCP tree.
- `bind` → deliver `ConversationBindScope` (identity, memory token, MCP caller identity, memory block, first message) to the worker, then `warmQuery.query(stream)`; return a handle that quacks like today's spawned `ChildProcess` (so `onProcess`/`registerProcess`/`GANTRY_OUTPUT`/`AgentOutput` are unchanged).
- `recycle` → close the `WarmQuery`/process, free its response key + egress gateway, schedule a replacement.

### 5.4 The integration seam (substitution point)
**The only child-process creation in the message path is `executeRunnerProcess`'s `spawn()` (`agent-spawn-process.ts:189`), reached only via `spawnAgent` (`agent-spawn.ts:743`).** Pool-on: `spawnAgent` asks the pool manager for a worker; on hit, it skips `spawn()` and uses the bound worker's handle; on miss (empty pool / not `WarmPoolCapable`), it falls back to today's cold `executeRunnerProcess`. **Contracts that MUST stay identical** (or stop/steering/streaming break):
- still call `onProcess(handle, runHandle)` → `registerProcess` records `state.process`/`state.runHandle` (`group-agent-runner.ts:567/578`); stop (`group-queue.ts:413`), continuation `sendMessage`→`writeContinuationInput` (`:365`), `closeStdin` (`:399`), `notifyIdle` (`:343`) all key off `state.process`.
- still emit `GANTRY_OUTPUT` envelopes on the handle's stdout (parsed `agent-spawn-process.ts:286`).
- still resolve an `AgentOutput` at turn end.
- **but DON'T kill the worker at teardown** — `runForGroup`'s `finally` (`group-queue.ts:482-493`) and `spawnAgent`'s `finally` (`agent-spawn.ts:759`) null/reap the process; for Model A we *do* destroy after the conversation (use-once), so teardown maps to `pool.release()` (destroy + replace), not a leak and not a reuse.

---

## 6. Boot-generic restructure (move per-customer state off the boot path)
1. **Memory block** — already the first user message ✅ (no change; just ensure it's pushed at bind, not at boot).
2. **Guardrail append** — move from the system-prompt append to a per-turn user-message preface (so it doesn't require a fresh `query()` and doesn't perturb the cached prefix).
3. **Boundary policy** — make unconditional (§2.3) so the prefix is byte-identical.
4. **Resume handle** — generic boot omits `resume` (fresh session). See §6.4 for returning-customer handling.
5. **The shared prefix is the cache anchor** — verify byte-identical across customers post-1–3 (test: two customers → identical `systemPrompt` bytes).

### 6.4 The resume problem (returning customers with a saved session)
A generic worker boots session-less. A *new* conversation needs no resume (fine). A *returning* customer with a saved `externalSessionId` normally resumes at `query()` boot — which a generic worker didn't do. Options (decision §19 D-P2-1):
- **(a) Accept a session-less first turn** for returning customers when served from the pool (capture `newSessionId`; the conversation continues warm). Simplest; the only cost is the resumed-context isn't loaded for that one turn — may be acceptable since durable memory is re-injected via the memory block anyway.
- **(b) Pool only serves first-ever / no-session conversations**; returning-with-session falls back to cold resume-spawn. Safe, narrower win.
- **(c) Investigate SDK session attach-post-boot** (none found today) — defer.
**DECIDED (D-P2-1): (b) for v1** (pool the genuinely-cold new conversations — the common case at scale); revisit (a) only if data shows returning-cold is large and (a) is provably equivalent.

---

## 7. Late-bind of per-customer identity (the Pillar 1 dependency)
The PER-CUSTOMER items (§2.2) that are *credentials/identity* (not just the message) are env-baked at spawn today. A generic worker has none of them. They must be delivered at **bind** — and the clean channel is **Pillar 1's two-phase socket handshake**: the worker connects generic (phase a), and the conversation scope + per-customer creds are delivered at bind (phase b).

### 7.1 What flows at bind (over Pillar 1's socket)
Bind channel socket path, recomputed `GANTRY_MEMORY_IPC_AUTH_TOKEN` (chatJid-scoped, server-validated), the MCP caller-identity (re-signed, fresh `ts`), the gantry-MCP child's customer identity (§7.2), a fresh run handle, the egress principal, and the first message + memory block + guardrail preface.

### 7.2 The structural fix: gantry-MCP child customer binding (the hardest part)
Today the gantry-MCP stdio child reads `GANTRY_CHAT_JID` as an **env constant at its own spawn** and stamps it (`targetJid`) on every outbound IPC task (`messaging.ts:204`) — **no per-call rebind**. A pre-warmed worker's MCP child booted generic would carry the wrong identity. Fix options (decision §19 D-P2-2):
- **(a) Per-turn identity input:** the gantry-MCP server reads the current conversation identity from a bind-delivered source (the socket / an IPC control message) instead of its env constant — stamping the *bound* chatJid per call. Clean, aligns with Pillar 1; requires changing the MCP server to treat identity as runtime state, not a constant.
- **(b) Swap the MCP server at bind** via the SDK `setMcpServers()` (`sdk.d.ts:2354`) with a customer-stamped instance — pays a reconnect cost at bind (after a free boot), but no MCP-server code change.
- **(c) Re-bootstrap the MCP child at bind** — defeats the MCP-connect savings.
**DECIDED (D-P2-2): (a)** per-turn identity input is the durable answer and the spike must prove it; **(b)** `setMcpServers()` swap is the fallback if (a) is too invasive. The MCP **caller-identity header** (boondi-crm/shopify) has the same shape — re-sign at bind with a fresh `ts`; if the live connection can't swap the header, route those connectors through the per-call facade proxy (`mcp-tool-proxy.ts:255`, which already re-signs per call).

### 7.3 Lifecycle widening (per-turn → per-worker)
- **Response signing keypair** (`createIpcAuthEnvelope` → minted per spawn, revoked at run end `agent-spawn.ts:773`) must stay registered for the **worker's** lifetime (mint at prewarm, revoke at recycle), or be re-minted at bind.
- **Egress gateway** (`ensureEgressGateway`, keyed by conversation/run `agent-spawn.ts:534-556`) must outlive the turn — pre-create generic at prewarm and rebind the principal at bind, or stand it up at bind.
- **Model credentials** (broker fetch `agent-spawn.ts:398`, revoked in the spawn `finally`) — a warm worker needs them at boot and must keep them for its lifetime (revoke at recycle, not at turn end). (F6)
- **The runner hard-kill timer** (`agent-spawn-process.ts:227-247`, ≈30.5 min) must be armed **at bind**, not at generic boot, or a waiting warm worker is SIGKILL'd as a "stall." (F2)

---

## 8. Prompt-cache warmth
- **What it buys:** the first model call reads the warm shared prefix (cache **read**, ~0.1×) instead of the cold **write** (1.25×, the 6,384-tok `cache w` in the trace) → shorter first LLM `providerWaitMs` detail.
- **Mechanism:** the shared Boondi prefix (system prompt + tools) is identical across customers; continuous traffic keeps it hot within the **5-min TTL**; for gaps, a **`max_tokens:0` pre-warm** (claude-api skill) writes the cache without an output. Min cacheable prefix: 4096 tok (Opus/Haiku), 2048 (Sonnet).
- **Open question (D-P2-3):** can a `max_tokens:0` pre-warm be issued *through* the Claude Agent SDK, or only via a direct Messages API call? If only direct, prompt-cache warmth = "rely on continuous traffic + the warm-pool boot itself" (the prewarm worker's own first call writes the cache; subsequent customers read it). The spike measures `cacheRead`/`cacheWrite` (`LlmTurnRecord.detail.tokens`) to confirm.
- Neutral: `prewarmCaches?()` is the optional hook; Anthropic implements it, other providers omit.

---

## 9. The SDK-capability spike (THE GATE — first deliverable, Pillar-1-independent)
Before any pool code. Proves the load-bearing assumptions on a real runner + fake SDK.

**What it must prove:**
1. A runner booted **generic** (no `prompt`/`compiledSystemPrompt`/`chatJid`/identity) can accept the customer's **first message + per-customer context** at runtime and reply **with no re-spawn** (`readRecord(fixture).calls.length === 1`; context appears in `call.streamMessages`, not the boot `systemPromptAppend`).
2. The reply's trace has **no `startup` section** and shows the warm split (`queue` pickup plus LLM `providerWaitMs` via `dispatchedAt`) — the assertion in `reply-trace.test.ts` (`assembleTimeline`: `startup` only when `startup.readyAt > startup.startedAt`; provider wait is folded into the following LLM section).
3. **Per-customer routing is correct after bind** — especially the **gantry-MCP child** stamps the *bound* chatJid (§7.2), not a generic/boot one (use `ipc-mcp-stdio.test.ts` `createMcpFixture`; assert `task.chatJid`/`targetJid` = bound customer).
4. **Cache warmth observable:** first `llm` turn shows `cacheRead > 0 && cacheWrite === 0` on the second+ customer (`detail.tokens`).
5. The SDK `startup()`/`WarmQuery` path works as documented (boot → `warmQuery.query(stream)` → reply), single-use respected.

**Harness:** `agent-runner-ipc.test.ts` `createRunnerFixture()` / `runRunner()` / `readRecord()` (real runner, fake SDK injected by filesystem placement). Extend `baseInput()` for a contextless boot; deliver the first message via the IPC/stream path; assert one `query()` call.

**The gate:** all 5 pass → build the full pool. (3) fails (gantry-MCP child can't be late-bound cleanly) → escalate to §7.2(b) and re-spike; if still blocked → **step back and re-scope** to the partial win (pre-spawn the Node runner + lazy-MCP only, saving part of the 2 s) rather than force it. Honest: the spike is allowed to come back "partial."

---

## 10. Reset / isolation (Model A makes this simple)
Model A = use-once. A worker serves one conversation then is **destroyed**, never reused for another customer — so cross-customer context bleed is **structurally impossible** (the reset risk that worried us only exists in Model B). "Destroy clean" = kill the process tree, revoke its response key, close its egress gateway, free its socket connection. The **bleed guard** (`boondi-isolation.mjs`) still runs as defense-in-depth, because bind-time identity routing (§7) is the place a bug could mis-route.

---

## 11. Edge-case catalog (each needs a test in §15)
1. **Pool empty on demand** → fall back to cold `executeRunnerProcess` (no user impact, just slower).
2. **Adapter not `WarmPoolCapable`** → cold spawn (direct-API/Codex path).
3. **Worker dies while idle-warm** → health-check evicts + replaces; never handed out dead.
4. **Worker dies mid-bind** (after acquire, before reply) → fall back to a fresh cold spawn for that customer; recycle the dead handle.
5. **Bind fails** (identity/token/MCP re-sign error) → fall back to cold spawn; never serve a half-bound worker.
6. **Customer never arrives** (warm worker idles) → idle-eviction after a TTL; re-warm to maintain pool size; respect the cache 5-min TTL (re-warm or accept a cold cache).
7. **Cache TTL expired on a warm worker** → first model call writes cache again (one-time); optionally `prewarmCaches`.
8. **`WarmQuery.query()` called twice** → guarded; single-use enforced (one bind per worker).
9. **Returning customer with a saved session** → §6.4 path (v1: cold resume-spawn fallback).
10. **MCP disconnect on a warm worker** → health-check (`mcpServerStatus()`); evict + replace, or `reconnectMcpServer()`.
11. **gantry-MCP child stamps stale/generic chatJid** → caught by spike (3) + isolation suite; bind must rebind identity before first tool call.
12. **MCP caller-identity `ts` staleness** (pre-signed at warm, used later) → re-sign at bind, not at prewarm.
13. **Response key revoked too early / egress gateway closed at turn end** → lifecycle widened to per-worker (§7.3).
14. **Prewarm storm** (many workers booting at once) → bounded concurrency on `prewarm`; backpressure.
15. **Stop / `/stop` during a pooled run** → `state.process` registered, so stop works unchanged; recycle on stop.
16. **Slot-isolation false-wait** — `measure-latency.mjs` waits for `activeRunnerPids → 0`; warm idle workers never reach 0 → the latency harness must use a different readiness signal under pool-on (§15/§17).

---

## 12. Security parity
Late-bind must preserve every per-customer guarantee that spawn-env provides today:
- **Memory IPC token** recomputed for the bound chatJid and **server-validated** (`ipc-auth-validation.ts` recomputes `computeMemoryIpcAuthToken` with the request chatJid) — a generic/blank token is rejected, so a mis-bound worker fails closed.
- **MCP caller identity** re-signed for the bound phone with a fresh `ts` (freshness window preserved).
- **gantry-MCP child** stamps the bound chatJid per call (§7.2) — no cross-customer task routing.
- **Response signing key** stays per-worker, private key core-side, revoked at recycle.
- **Use-once** = no residual customer state survives to a next customer.
- Defense-in-depth: the isolation suite proves no bleed under concurrency.

---

## 13. Provider neutrality
Per Pillar 1 §4.4: `WarmPoolCapable` is an **optional** capability resolved through the `AgentExecutionAdapter` registry. Anthropic-CLI implements it (via `startup()`); an in-process **direct-API** adapter omits it (no subprocess cold start to hide) and the pool manager falls back to cold `prepare()`; a future **Codex** adapter implements it however Codex warms. No warm-pool concept leaks into the neutral pool manager beyond the neutral verbs. Neutrality test: "the pool manager must make sense for any provider."

---

## 14. Concurrency & sizing (ships, but policy deferred)
- Pool size bounded by the **account's** throughput + burst headroom (not customer count) — a small N now (1–2).
- Model A re-warm cadence: replace each used worker; keep N warm.
- Backpressure: bounded prewarm concurrency; on exhaustion, cold-spawn fallback (graceful).
- Relationship to `MAX_MESSAGE_RUNS=3`: the pool feeds the same run slots; raising concurrency is the *scale* phase, not Pillar 2.

---

## 15. Test plan
Mirror Pillar 1's rigor; reuse harnesses.
- **Spike (the gate, §9):** `createRunnerFixture` real-runner test — generic boot → runtime bind → one `query()` call, no `startup` span, correct gantry-MCP chatJid, cacheRead>0.
- **Boot-generic unit:** two customers → byte-identical `systemPrompt` prefix; guardrail append + memory block delivered per-turn; boundary policy unconditional.
- **Pool-manager unit:** modeled on `group-queue.test.ts` (constructor-injected size, `vi.useFakeTimers`); use `createFakeAgentRunner` (`blockUntilReleased`/`releaseNext`) as the worker → prewarm N / acquire / recycle-replace / exhaustion-fallback / idle-evict. Assert use-once (a recycled worker is never handed to a second `chatJid`).
- **Failure injection:** worker-dies-warm, dies-mid-bind, bind-fails → cold fallback; `createMcpFixture` for per-customer-identity isolation when identity is late-bound.
- **Trace assertions:** `assembleTimeline` no-`startup` + warm split; `detail.tokens` cache-warmth; `selectTurnTraceSlice` (pooled worker behaves like a long-lived warm process).
- **E2E gate (§17):** `boondi-regression` (pool off==on, correctness), `boondi-isolation` (bleed under concurrency — the key pool risk), `measure-latency` (cold `spawnToLlmInputMs` collapses toward warm; `firstCacheRead>0`) — with the **slot-isolation caveat** handled (don't wait on `activeRunnerPids→0`).
- Every §11 edge case → a test.

---

## 16. Parallel-worktree strategy (build Pillar 2 alongside Pillar 1)
Pillar 1 lives in worktree A (in implementation). Pillar 2 develops in **worktree B**, branched from the same base, combined later. Design for clean merge:

### 16.1 What's independent of Pillar 1 (do now, worktree B)
- **The spike (§9)** — pure SDK + runner; no socket. *De-risks everything.*
- **Boot-generic restructure (§6)** — runner-side (`system-prompt.ts`, `query-loop.ts`, `message-stream.ts`): move guardrail append + make boundary policy unconditional + confirm memory-as-first-message. Additive, flag-gated.
- **Pool manager (§5.1)** + **`WarmPoolCapable` interface (§5.2)** + **Anthropic `startup()` impl (§5.3)** — mostly NEW files.
- **Prompt-cache warmth (§8)** — independent.
- Standalone testing of pool-on uses a **temporary bind shim** (deliver identity via the *current* mechanism, or a stub) so Pillar 2 is exercisable without the socket.

### 16.2 What depends on Pillar 1 (the integration seam — wire at combine)
- **Late-bind of per-customer identity over the socket (§7).** In worktree B, code to the **two-phase-handshake contract** (Pillar 1 §4.4/§6.2) behind an interface; the real wiring (bind-phase delivers identity over Pillar 1's socket) happens when the worktrees combine.

### 16.3 File ownership (minimize merge conflicts)
- **Pillar-2-owned NEW files:** `warm-pool-manager.ts` (neutral), `WarmPoolCapable` interface (in `application/agent-execution/`), `adapters/llm/anthropic-claude-agent/warm-pool.ts`, spike tests, pool tests.
- **SHARED files both pillars touch** (keep Pillar 2's edits minimal + additive + behind `GANTRY_WARM_POOL`): `agent-spawn.ts` (the seam substitution), `agent-spawn-process.ts` (return-to-pool branch), `agent-capabilities.ts` (gantry-MCP identity late-bind — overlaps Pillar 1's env work), `query-loop.ts` / `system-prompt.ts` (boot-generic), `agent-execution-adapter.ts` (the optional capability), `group-queue.ts` (don't-kill-on-teardown branch). For each, Pillar 2 adds a *flag-guarded branch* rather than restructuring shared code, so merges are additive.
- **The riskiest overlap is `agent-capabilities.ts` + the identity path**, which both pillars modify (Pillar 1: socket creds; Pillar 2: late-bind identity). Resolve by having Pillar 1 land the socket-credential delivery first, then Pillar 2's late-bind builds on it.

### 16.4 Combine plan
1. Land **Pillar 1** to its branch (passes its E2E gate).
2. Rebase/merge **Pillar 2** worktree onto Pillar 1's branch.
3. Replace the temporary bind shim with the real socket late-bind (§16.2).
4. Run the **full E2E gate** (§17) with `GANTRY_WARM_POOL` off (identical baseline) and on (latency win, no behavioral delta).
- Alternative the operator offered: I produce Pillar 2 to the "shim" stage in worktree B now; when Pillar 1 completes, a follow-up prompt wires the socket late-bind + runs the combined E2E.

### 16.5 Flag
`GANTRY_WARM_POOL` (settings.yaml runtime setting or `.env` dev flag; boot-parsed), **default off**. Off ⇒ today's cold-spawn path, byte-identical behavior and tests. On ⇒ pool path. Per-channel-style reversibility: flip off to fall back instantly.

---

## 17. Acceptance criteria — same as Pillar 1 (the SOLE gate)
Boondi driven E2E via `docs/BOONDI-E2E-TESTING.md` — real signed Interakt webhook + full message processing + **all commands** (`/new`, `/digest-session`, `/extract-leads-queries`, `/commands`, `/stop`) — behaving **identically to today**, proven in the admin panel.
- **Method:** run the §15 E2E harnesses with `GANTRY_WARM_POOL` **off** (baseline) then **on**; results **identical** in behavior (`boondi-regression` + `boondi-isolation`), with `measure-latency` showing the cold first reply's `startup`/`spawnToLlmInputMs` collapsed and `firstCacheRead>0`.
- **Equivalence guarantees:** flag default-off (pool additive); same handlers/payloads; one reversible substitution seam; use-once (no bleed).
- **Pool-specific success signal:** the first reply of a pooled conversation has **no `startup` section** in `timings_json` and behaves exactly like a warm continuation otherwise.
- **Caveat to handle:** `measure-latency.mjs` slot-isolation (`activeRunnerPids→0`) is invalid under a warm pool — the latency run must use a pool-aware readiness signal (or run without slot-isolation), documented in the test setup.
- **Definition of done:** §17 green under both flag states + a soak with no new error/loss/bleed.

---

## 18. Sequencing / phases
1. **Spike (gate).** Generic-boot → runtime-bind → no re-spawn, no `startup`, correct gantry-MCP identity, cacheRead>0. Pass → continue; partial → re-scope.
2. **Boot-generic restructure** (§6) + tests.
3. **Pool manager + `WarmPoolCapable` + Anthropic `startup()` impl** (§5) + unit/failure tests, using the temporary bind shim.
4. **Standalone E2E** (pool-on via shim): regression + isolation identical; latency shows startup collapse.
5. **Integrate with Pillar 1** (§16.4): real socket late-bind (§7); structural gantry-MCP identity fix (§7.2).
6. **Full E2E gate** (§17) under both flag states; soak.

---

## 19. Decisions (operator-approved 2026-06-15)

**Unifying principle:** treat ALL per-customer identity as **runtime state late-bound over Pillar 1's socket and re-validated per-message by core** — never baked at spawn. This resolves D-P2-2 and D-P2-5 together and keeps security parity (core recomputes the chatJid scope on every IPC message, so a runtime-bound identity is validated downstream exactly as a spawn-baked one is).

- **D-P2-1 (returning customers) — DECIDED: (b)** pool only no-session (genuinely new) conversations; a returning customer with a saved session falls back to today's cold resume-spawn. *Why:* the only option that guarantees the equivalence gate — returning customers behave byte-identically, while new conversations (the common cold-start case at scale) get the win. (a) risks a different first-turn reply (resumed transcript missing); revisit only if data shows returning-cold is a large slice AND (a) is provably equivalent.
- **D-P2-2 (gantry-MCP identity) — DECIDED: (a)** per-turn identity input — the gantry-MCP server reads the *bound* identity at runtime (delivered at bind) instead of its spawn env constant; fallback **(b)** `setMcpServers()` swap if (a) proves too invasive. *Why:* only (a) preserves the full warm benefit; (b)/(c) reintroduce a reconnect/re-spawn at bind (part of the 2 s we're removing). Secure because core re-validates scope per message. **Scope (F4): the per-turn identity must reach ALL readers** — the gantry-MCP child (`context.ts:53`), the runner permission flow (`permission-callback.ts:109`, falls back to env `CHAT_JID`), and messaging/`ask_user_question` (`messaging.ts:127,204`) — not just the MCP child. **Spike must confirm (a) is feasible** and that permission/question routing is correct.
- **D-P2-3 (prompt-cache pre-warm) — DECIDED: do not depend on the SDK answer.** Cache-warmth works via continuous traffic + the pool's own first call (the server-side cache is shared by prefix across processes within the 5-min TTL, so customer 1's first turn warms it for customer 2). Add the explicit `max_tokens:0` pre-warm ONLY if the spike shows it is issuable through the Agent SDK — a bonus, not a dependency. **Spike measures.**
- **D-P2-4 (pool size) — DECIDED:** configurable **N, default 1–2**, cold-spawn fallback on exhaustion; auto-sizing/fairness deferred to the scale phase. *Why:* matches the per-conversation-now priority; a settings knob lets prod scale without code; exhaustion degrades gracefully to today's cold path.
- **D-P2-5 (MCP caller-identity) — DECIDED:** route credentialed connectors through the **per-call facade proxy** (`mcp-tool-proxy.ts:255`, which already re-signs identity per call — no frozen header, no connection swap; with Pillar 1 its IPC hop is fast). Folds into D-P2-2(a). **Spike confirms one fact:** Boondi's current routing — the Pillar 1 trace (`get_open_records`/`search_products` via `mcp_call_tool`) suggests they may already be facade-routed, in which case this is largely solved.

**The spike (§9) is the gate, and it confirms the three still-open facts:** D-P2-2(a) feasibility, D-P2-3 SDK pre-warm capability, and the D-P2-5 routing fact. Everything else above is locked.

---

## 20. File-by-file change map
**NEW (Pillar-2-owned):**
- `apps/core/src/runtime/warm-pool-manager.ts` — neutral pool lifecycle.
- `apps/core/src/application/agent-execution/warm-pool-capable.ts` — the optional capability interface + `SharedBootRecipe`/`ConversationBindScope` types.
- `apps/core/src/adapters/llm/anthropic-claude-agent/warm-pool.ts` — `startup()`/`WarmQuery` impl + late-bind.
- tests: spike (`runner/warm-pool-spike.test.ts`), pool unit (`runtime/warm-pool-manager.test.ts`), trace/no-startup assertions, failure injection.

**MODIFIED (minimal, additive, `GANTRY_WARM_POOL`-guarded):**
- `agent-spawn.ts` — seam substitution (acquire-or-spawn) + lifecycle widening (response key, egress per-worker).
- `agent-spawn-process.ts` — return-to-pool / don't-reap branch.
- `agent-capabilities.ts` — gantry-MCP identity late-bind (coordinate with Pillar 1).
- `runner/system-prompt.ts`, `runner/query-loop.ts`, `runner/message-stream.ts` — boot-generic (guardrail-per-turn, unconditional boundary policy, memory-as-first-message confirm).
- `application/agent-execution/agent-execution-adapter.ts` / registry — wire the optional capability.
- `group-queue.ts` — don't-kill-pooled-worker-on-teardown branch.
- config/settings — `GANTRY_WARM_POOL` flag + pool size.

**UNCHANGED (reused):** the Pillar 1 socket + handshake (consumed for late-bind), reply-trace, the E2E harnesses, the security/auth model.

---

## 21. Appendix — source references
- Bound-state inventory: `agent-spawn.ts`, `agent-capabilities.ts`, `runner/query-loop.ts`, `runner/system-prompt.ts`, `runner/message-stream.ts`, `runner/bind-channel.ts`, `runtime/ipc-auth.ts`, `application/mcp/mcp-caller-identity.ts`, `application/capability-secrets/mcp-secret-projection.ts`, `runtime/memory-boundary.ts`, `prompt-cache.ts`.
- Integration seam: `runtime/group-queue.ts`, `runtime/group-agent-runner.ts`, `runtime/agent-spawn.ts`, `runtime/agent-spawn-process.ts`, `application/agent-execution/agent-execution-adapter.ts` (+ registry).
- SDK: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`startup` 5676, `WarmQuery` 5933, `query` 2391, `streamInput` 2361, `SDKUserMessage` 3741, session options 1695/1320/1701, `mcpServers` 1601, `systemPrompt` 1909).
- Tests/observability: `test/unit/runner/agent-runner-ipc.test.ts` (`createRunnerFixture`), `test/unit/runner/ipc-mcp-stdio.test.ts` (`createMcpFixture`), `test/harness/fake-agent-runner.ts`, `test/unit/runtime/group-queue.test.ts`, `runtime/reply-trace.ts` + test, `scripts/boondi-regression.mjs`, `scripts/boondi-isolation.mjs`, `scripts/measure-latency.mjs`.

---

## 22. Production-readiness findings (deep review, 2026-06-15)

Re-verified the design against source. None invalidate the approach, but **F1–F4 + F7 are correctness/liveness must-fixes** that make the pool "more than spawn-early" — it requires a runner two-phase entry, a warm-bound trace signal, full identity late-bind, and pool-owned lifetime/shutdown. All folded into the design below.

- **F1 — `runnerStartup` mis-attributes a pooled worker's first reply (CRITICAL, trace correctness).** `firstSdkMessageAt` is stamped at the worker's *generic boot* (`query-loop.ts:393-396`, `messageCount===1`); the runner emits `runnerStartup` on every result while `firstSdkMessageAt !== undefined` (`query-loop.ts:607-609`); core attaches `startup = {startedAt: agentRunStartedAt, readyAt: firstSdkMessageAt}` on the first reply (`group-processing.ts:416-423`). For a pooled worker, boot precedes bind, so `readyAt < startedAt` → `assembleTimeline` *drops* the startup span (`reply-trace.ts:286`) — good — but the reply still takes the `isFirstReply→startup` branch, **not** the `dispatchedAt→LLM provider-wait` branch, so the lead is lumped as one `queue` with no LLM `providerWaitMs` detail, mis-stating the trace. **Fix:** bind carries a `warmBound` marker so the runner emits **`dispatchedAt`** (not `runnerStartup`) and core's `persistReplyTraceForTurn` routes the pooled first reply through the continuation path. (Amends §9/§17 success criterion: "no startup row, with clean `queue` pickup and LLM `providerWaitMs` detail.")
- **F2 — the runner hard-kill timer reaps idle warm workers (CRITICAL, pool liveness).** Each runner has `timeoutMs = max(configuredTimeout, IDLE_TIMEOUT + 30_000)` ≈ **30.5 min**, armed at spawn, reset on activity, firing `runner.kill('SIGKILL')` (`agent-spawn-process.ts:227-247`). A waiting warm worker makes no progress → it's on a 30.5-min fuse from boot, and "no progress ⇒ kill" is the opposite of "keep a spare ready." **Fix:** arm the runner timeout **only at bind** (pass a "warm, unbound" flag so it's deferred), with the 30.5-min fuse as a backstop max-warm-TTL; the pool also keeps its own short idle-eviction TTL. (Amends §7.3, §11.)
- **F3 — the runner entry is once-only stdin, and stdin is closed (CRITICAL, runner restructure).** Runner reads input once: `readStdin()`→`JSON.parse`→`runQuery` (`index.ts:65-66,94,198`); core closes stdin immediately (`agent-spawn-process.ts:201-202`). So bind **cannot** use stdin. `index.ts` must use a **two-phase entry**: (1) read a *generic* `AgentRunnerInput`, `startup()`-boot, signal ready; (2) receive the **bind** (identity + first message) over Pillar 1's socket bind channel and then run. (Amends §6/§16; the spike must exercise exactly this.)
- **F4 — late-bind must cover the RUNNER's identity readers, not only the gantry-MCP child (CRITICAL, correctness/security).** Beyond `context.ts:53` (`chatJid = env.GANTRY_CHAT_JID`), the runner permission flow falls back to env `CHAT_JID` for the approval target (`permission-callback.ts:109`), and `ask_user_question`/`send_message` stamp `targetJid: chatJid` from env (`messaging.ts:127,204`). A generic worker would mis-route permission prompts / questions / outbound to the generic JID. **Fix:** D-P2-2's per-turn identity must reach **every** reader (gantry-MCP child + permission-callback + messaging). Spike must assert correct routing for a permission prompt and an `ask_user_question`, not just a tool call. (Amends §19 D-P2-2, §9.)
- **F5 — caller-identity freshness confirms D-P2-5.** Connectors verify the identity `ts` against `maxAgeSec` (`mcp-shopify/src/server.ts`, `mcp-crm/src/server.ts`; default 120 s when disabled, else configured), signed at `Date.now()` (`mcp-caller-identity.ts:103`). A header signed at warm-time and used > `maxAgeSec` later is **rejected** → identity must be (re)signed at/near tool-call time → **facade per-call (D-P2-5)** is correct. (Verify exact `maxAgeSec` in the spike.)
- **F6 — lifecycle widening is broader than §7.3.** Add **model credentials** (broker fetch `agent-spawn.ts:398`, revoked in spawn `finally`) and **the hard-kill timer** (F2) to the per-turn→per-worker list, alongside the response signing key and egress gateway.
- **F7 — pool shutdown + orphan reaping (resource leak).** Warm workers are **not registered in `GroupQueue`** (registration is at bind), so `GroupQueue.shutdown` (signals active *runs* only) won't kill idle pool workers. **Fix:** the pool manager owns its own shutdown (kill all warm workers) + a **boot-time sweep** to reap orphaned warm workers from a previous core (tag them with a distinctive `processName`/argv marker). (Amends §16, §11.)
- **F8 — pool key must include every boot-affecting config.** A default-Boondi worker can't serve a conversation with a `group.agentConfig` override (model/thinking/persona/toolSurface). Pool key = `(providerId, appId, agentId, persona, model, toolSurface, mcpSet, thinking, systemPromptVersion)`; no matching bucket → cold-spawn fallback. (Amends §5.1.)
- **F9 — pool concurrency.** `acquire` must be atomic (no double-hand-out); Model-A `release` = destroy + boot replacement, with **backoff-retry on a failed replacement boot** (never permanently shrink the pool); cap concurrent `prewarm`. (Amends §5.1/§11.)
- **F10 — spike harness must model the SDK warm primitive.** `createRunnerFixture`'s fake SDK exports `query()`; extend it to export **`startup()`→`WarmQuery`** with a **single-use** `query()` so the warm path is faithfully exercised. (Amends §9.)
- **F11 — idle warm workers reserve real resources + MCP idle-disconnect.** Each holds ~3 processes, an OAuth/model-cred slot, an egress gateway, a response key, and **live MCP connections** that a connector may drop on idle. Add an **MCP health check** (`mcpServerStatus()`/`reconnectMcpServer()`) before hand-out; §14 sizing must account for per-idle-worker cost. (Amends §11/§14.)
- **F12 — the warm boot does NOT write the model prompt cache.** `startup()` boots the CLI + initialize handshake but makes **no model API call**, so it writes no Anthropic prompt cache. Cache warmth comes from **cross-customer server-side cache sharing** (prefix-keyed, cross-process, 5-min TTL) + the optional `max_tokens:0` pre-warm (D-P2-3) — **not** from the warm boot. (Amends §8.)
