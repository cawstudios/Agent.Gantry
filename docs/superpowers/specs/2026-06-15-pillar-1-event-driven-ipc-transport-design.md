# Pillar 1 — Event-Driven IPC Transport (Design Spec)

- **Status:** DRAFT for deep review. Not approved. No code to be written until this is signed off.
- **Date:** 2026-06-15
- **Scope:** Replace Gantry's filesystem-polling IPC between `core` and the worker processes (`agent-runner` + `gantry-MCP` stdio subprocess) with a **Unix-domain-socket, event-driven transport** ("Option B" — the switchboard). Single-conversation correctness and robustness first; built as the primitive that scales to 100s of concurrent conversations without a rewrite.
- **Non-goals (this pillar):** warm worker pool (Pillar 2), async DB persist / hot context (Pillar 3), model/LLM changes, Shopify/CRM changes, any change to the agent's per-agent tool model (it is correct and is preserved).
- **Hard constraint:** every existing **security guarantee** and **robustness/recovery property** must be preserved or improved. The crypto envelopes are reused **byte-for-byte**; only the *carrier* changes (file-in-directory → frame-on-socket).

> Throughout, `core` = the privileged gatekeeper that holds secrets and executes privileged work; `worker` = the sacrificial, low-privilege child tree (agent-runner → Claude Code CLI → gantry-MCP). Trust flows one way: core mints per-spawn credentials; the worker can never escalate.

---

## 1. Goals & success criteria

### 1.1 Latency (the reason we're here)

Remove the **polling tax** from a reply. Measured against the two reference traces (`docs/BOONDI-`* + the admin reply-latency report):


| Section                            | today                                                           | target after Pillar 1                                                                                                                                                                  | mechanism                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| warm `queue`                       | **p50 934 ms** (measured; the 759 ms screenshot was an outlier) | **~450 ms** (carrier swap — behavior-identical; one poll, the message-loop DB tick, remains) → **< ~50 ms** (with the opt-in message-loop event-trigger, §20 I-R1, batching preserved) | the runner-side 500 ms IPC poll + carrier are removed with guaranteed equivalence; removing the *message-loop* 500 ms poll is the separate opt-in step |
| `gap` (per tool call)              | 98–982 ms                                                       | **< ~30 ms**                                                                                                                                                                           | `mcp_call_tool` request delivered as a frame, picked up instantly instead of the 1000 ms core IPC-watcher poll                                         |
| post-tool IPC tail in `model_wait` | ≤150 ms                                                         | **< ~15 ms**                                                                                                                                                                           | tool response delivered as a frame, not the 150 ms `waitForTaskResponse` poll                                                                          |


**Measured reality (2026-06-15, from `gantry.message_traces`):** the COLD queue is already fine — p50 44 ms / p99 323 ms (the 329 ms screenshot was an outlier), so there is nothing to trim there and **Pillar 3 (hot context / DB caching) is DROPPED**. The prize is the WARM queue (p50 934 ms = the two stacked 500 ms polls). The warm-queue **long tail (p90 3.5 s, p99 ~100 s) is run-slot saturation** (`MAX_MESSAGE_RUNS=3` + 30-min `IDLE_TIMEOUT` slot-holding + the per-conversation process model) — that is the **concurrency phase, explicitly OUT of Pillar 1 scope**. Pillar 1 fixes the warm-queue **p50**, not the tail.

Also out of scope for Pillar 1: `startup` (cold spawn — Pillar 2) and the model-TTFT portion of `model_wait` (the LLM itself).

### 1.2 Robustness parity (non-negotiable)

Every item in the "Edge cases the current system handles" checklist (§9, §11) is preserved or improved. No regression in: crash recovery, single-instance election, ordering, idempotency, replay protection, rate limiting, graceful shutdown.

### 1.3 Concurrency-ready

The transport's cost scales with **traffic**, not with the **number of conversations** (the key reason we chose B over A). The design must hold for 1 conversation and for 100s with only a capacity change (no architectural change). Concurrency *policy* (fairness, pool sizing) is Pillar-2+; the *mechanism* (multiplexed connections, per-connection backpressure) ships here.

### 1.4 Reviewability / safety of rollout

Feature-flagged, dual-runnable (socket + filesystem coexist), per-channel cutover, instant fallback, validated against the two reference traces before each channel is locked in.

### 1.5 Behavioral equivalence (THE HARD GATE)

At the **user level, Gantry core must behave identically** — no new errors, no changed outputs, no changed ordering, no changed observable timing-of-record. This is a release gate, not an aspiration (full detail + proof strategy in **§18**). The transport flag defaults to `fs`, so nothing changes for users or for the existing test suite until a channel is deliberately cut over, and **every cutover is gated on the functional test suite passing under BOTH carriers** (conformance testing, §18.3). Any change that would alter user-observable behavior (§18.5) is excluded from the equivalence core and ships separately, if at all.

### 1.6 Acceptance criteria — the ONLY gate (operator, 2026-06-15)

Pillar 1 is accepted **only** by driving Boondi end-to-end through `docs/BOONDI-E2E-TESTING.md` — a **real signed Interakt webhook**, **full message processing through every layer**, **and every command** (`/new`, `/digest-session`, `/extract-leads-queries`, `/commands`, `/stop`) — and confirming everything works **exactly as it does today**, proven in the admin panel. This is the single acceptance criteria; the full checklist + method (run on `fs` baseline, then `socket`, results identical) is **§19**. The unit/conformance tests (§18) are *supporting* dev-time verification that help us get there — they are not the gate. §19 is the gate.

---

## 2. Background — current architecture (condensed inventory)

### 2.1 Process topology

```
core (node)                         ← holds GANTRY_IPC_AUTH_SECRET, all creds; IPC watcher + message-loop
 └─ agent-runner child (node, dist) ← spawned by core via process.execPath (agent-spawn.ts:458)
     └─ Claude Code CLI subprocess  ← SDK query() spawns it (query-loop.ts:323); IPC secrets STRIPPED from its env (runtime-env.ts:163-168)
         └─ gantry-MCP stdio grandchild (node, dist/runner/mcp/stdio.js)  ← env is an explicit allow-list (agent-capabilities.ts:210-281)
```

Two worker processes touch IPC: the **agent-runner** and the **gantry-MCP grandchild**. They are different code paths with byte-identical crypto (`runner/mcp/signing.ts` and `adapters/.../runner/ipc-signing.ts` are deliberate copies).

### 2.2 The seams today (all filesystem + polling)


| Seam                                                 | Direction                                   | Medium                        | Poll                                                                  | Latency cost            |
| ---------------------------------------------------- | ------------------------------------------- | ----------------------------- | --------------------------------------------------------------------- | ----------------------- |
| continuation `input/` + `_close`                     | core → agent-runner                         | files in per-conversation dir | runner 500 ms (`IPC_POLL_MS`) + message-loop 500 ms (`POLL_INTERVAL`) | warm `queue`            |
| `tasks/` (`mcp_call_tool`, etc.) → `task-responses/` | gantry-MCP → core → gantry-MCP              | files                         | core watcher 1000 ms (`IPC_POLL_INTERVAL`); client 150 ms             | `gap` + post-tool tail  |
| `memory-*`, `browser-*`                              | gantry-MCP ↔ core                           | files                         | core 1000 ms; client 100 ms                                           | (not on hot reply path) |
| `permission-*`                                       | agent-runner ↔ core                         | files                         | core 1000 ms; client 100 ms                                           | interactive             |
| `user-questions` → `user-answers`                    | gantry-MCP ↔ core                           | files                         | core 1000 ms; client 100 ms                                           | interactive             |
| `messages/`                                          | gantry-MCP → core                           | files (fire-and-forget)       | core 1000 ms                                                          | outbound                |
| `live-tool-rules/<runHandle>`                        | core → worker                               | file, read per tool decision  | event-ish (read on demand)                                            | per tool gate           |
| `interaction-boundaries/`                            | gantry-MCP → agent-runner (worker-internal) | files, delete-to-ack          | runner 500 ms; producer 100 ms                                        | interactive flush       |


### 2.3 Full channel checklist (the transport MUST carry all of these)

From the core-channel inventory. Each row links to its authoritative current implementation.

1. `messages` (req-only, no response) — `ipc.ts:330`
2. `tasks` → `task-responses` — subtypes: scheduler create/mutate/query, `scheduler_wait_for_events` (long-running), admin (`refresh_groups`, `register_agent`, `service_restart`, `settings_desired_state`, `request_settings_update`, `admin_permission_revoke`, `request_skill_install`, `request_skill_dependency_install`, `request_permission`, `request_skill_proposal`, `request_mcp_server`), `mcp_list_tools` (long-running), `mcp_call_tool` (long-running), file-artifact handlers — `ipc.ts:393`, `jobs/ipc-handler.ts:17`, `jobs/ipc-admin-handlers.ts:489`
3. `memory-requests` → `memory-responses` — `ipc.ts:450`, `memory/memory-ipc.ts:583`
4. `browser-requests` → `browser-responses` (in-flight cap 4) — `ipc-browser-requests.ts:31`
5. `permission-requests` → `permission-responses` (interaction cap 100, idempotent) — `ipc.ts:531`
6. `user-questions` → `user-answers` (interaction cap 100) — `ipc.ts:643`
7. `input/` continuation (core→runner, per-conversation, strict order) — `continuation-input.ts:45`
8. `input/_close` sentinel (core→runner) — `continuation-input.ts:68`
9. `live-tool-rules/<runHandle>` (core→worker, read per tool decision) — `shared/live-tool-rules.ts`
10. `interaction-boundaries/` (gantry-MCP→agent-runner, delete-to-ack) — `runner/mcp/tools/messaging.ts:62`, `runner/.../ipc-input.ts:66`
11. Infra: `ipc/.lock` (single-watcher election + PID-recycle recovery) — `ipc-filesystem.ts:203`; `ipc/errors/` (quarantine) — `ipc-filesystem.ts:69`

---

## 3. Design principles (the invariants we must not weaken)

1. **Core recomputes, never trusts.** Identity (`sourceAgentFolder`), the HMAC key, and the response private key are all derived server-side from the spawn-time binding. Client-asserted `authToken`/`appId`/`agentId`/`threadId` are stripped or cross-checked-and-rejected, never used as-is (`ipc-auth-validation.ts:89-200`).
2. **Asymmetry of forgery.** Requests use a per-channel HMAC (worker can sign its own scope). Responses use **ed25519** (worker holds only the public verify key — it **cannot** forge a response, even on its own connection) (`infrastructure/ipc/response-signing.ts`, `runner/mcp/signing.ts:36-55`). A "trusted socket, no signature" response path would be a downgrade and is forbidden.
3. **Reuse the envelope, swap the carrier.** The exact `createSignedIpcRequestEnvelope` / `verifyIpcRequestPayload` / `signIpcResponsePayload` / `verifyIpcResponsePayload` functions and the exact JSON payloads are reused unchanged. The frame on the wire carries the identical serialized signed payload, so signature bytes match and the entire auth test corpus applies verbatim.
4. **Durability lives in the DB, not the pipe.** `recoverPendingMessages` (DB cursor) is the source of truth for "what still needs doing" and is **kept unchanged**. The socket is an accelerator; correctness never depends on a frame being delivered.
5. **Belt and suspenders.** The socket is the fast path; a **low-frequency reconciliation backstop** remains so a missed/dropped event can never lose work (see §9.4). Event-driven for speed, poll for safety.
6. **No silent scope widening.** Each connection is bound to exactly one `(folder, thread, appId, agentId, runHandle)` scope at accept-time and can never address another scope.

---

## 4. Target architecture

### 4.1 Topology — core is the switchboard

- **Core runs one Unix-domain-socket server** at a private path (e.g. `${DATA_DIR}/ipc/core.sock`), `0o600` under the `0o700` `ipc/` dir (same `private-fs` discipline as today).
- **Each worker process dials in.** Per active run there are **two** client connections:
  - **runner connection** (the agent-runner process): carries `permission-requests` (worker→core) and receives `input` continuation, `_close`, and `live-tool-rules` pushes (core→worker).
  - **MCP connection** (the gantry-MCP grandchild): carries `tasks`/`mcp_*`, `memory`, `browser`, `user-questions`, `messages` (worker→core) and their responses (core→worker), plus `live-tool-rules` reads.
- Core associates both connections with the run via the handshake scope (keyed by `runHandle` + folder/thread/app/agent).

> **Decision D1 (recommended):** one shared core socket with per-connection scope binding, **not** one socket per group. Rationale: a single bind = a single stale-socket recovery; the switchboard naturally multiplexes N connections; per-connection scope binding is exactly where the security model already draws the line. (See §15 for the alternative.)

### 4.2 Bidirectional, multiplexed, full-duplex

Each connection is full-duplex and carries **many concurrent in-flight requests** correlated by `requestId`. Long-running operations (`mcp_*`, `scheduler_wait_for_events`, permission/user-question waits) do not head-of-line-block other requests on the same connection — exactly as the current "detached handler" design avoids blocking the poll loop (`ipc.ts:36-77,410-419`).

### 4.3 What changes vs. what stays

**Changes:** the *carrier* (file write + directory poll → length-prefixed frame on a socket) and the *trigger* (timer → readable event). The continuation push, the tool-call round-trip, and the response delivery all become instant.

**Stays byte-identical / reused:**

- All request/response **payload schemas and parsers** (`ipc-parsing.ts`, `ipc-task-parsing.ts`).
- All **crypto** (HMAC request, ed25519 response, token derivation, key rotation, revoke-on-exit).
- All **authorization** logic (`validateSameChannelApprovalTarget`, folder-owned-JID check, context↔payload coherence, job execution-context binding, browser grant lifecycle).
- **Replay protection**, **rate limits**, **in-flight caps**, **per-conversation ordering** semantics.
- `**recoverPendingMessages`** and the DB cursor model.
- The **GroupQueue** concurrency model (`MAX_MESSAGE_RUNS`, retries, drain, shutdown).

---

## 5. The wire protocol

### 5.1 Transport

- `AF_UNIX`, `SOCK_STREAM` (ordered, reliable, local-only). No TCP, no network exposure.
- Socket file created with `ensurePrivateDirSync`/`writePrivateFileSync` discipline (parent `ipc/` dir is `0o700`, owned by core's uid, non-symlink asserted). **This is the primary OS isolation:** only core's uid can traverse the `0o700` dir to open the socket. An optional peer-credential/uid check (`SO_PEERCRED` on Linux / `getpeereid`/`LOCAL_PEERCRED` on macOS; not exposed by Node natively, so it needs a small platform helper) is defense-in-depth — but **never** a replacement for the per-message signatures/scope binding (see §8). If the platform helper is unavailable, the `0o700` dir + signed handshake still hold.

### 5.2 Framing

- **Length-prefixed frames:** 4-byte big-endian unsigned length + UTF-8 JSON body.
- **Max frame size** enforced (e.g. 1 MiB default, configurable) → oversized frame ⇒ connection error + quarantine log (analog of dropping an oversized file). This is a net-new protection (today an oversized JSON file is merely archived).
- **Partial reads** buffered until a full frame is assembled; a frame that never completes within a bound ⇒ connection reset.
- Robust to TCP-style coalescing/splitting (multiple frames per read, or a frame split across reads).

### 5.3 Envelope schema (on the wire)

```
Frame = uint32(len) ++ JSON({
  v: 1,                        // protocol version
  type: 'req' | 'resp' | 'push' | 'ctrl',
  channel: 'task' | 'memory' | 'browser' | 'permission' | 'user_question'
         | 'message' | 'continuation' | 'close' | 'live_tool_rules'
         | 'interaction_boundary',
  id: string,                  // requestId / correlation id (UUID-form, as today)
  payload: <the EXACT signed object today>,   // signed bytes unchanged
})
```

- For `type:'req'` the `payload` is the current signed request envelope (HMAC `signature` field inside it). For `type:'resp'` the `payload` is the current signed response object (ed25519 `signature` inside it). **Core verifies/produces these with the existing functions, unchanged.**
- `type:'push'` is core→worker delivery that has no response today (continuation, `_close`, live-tool-rules). `type:'ctrl'` is transport control (handshake, heartbeat, drain) — see §6.

### 5.4 Signing — reused verbatim

- **Request:** `createSignedIpcRequestEnvelope(token, payload)` on the client (HMAC-SHA256 over the full payload incl. `requestId`/`nonce`/`expiresAt`/`context`); core validates by **recomputing the channel-scoped key** from the connection's bound folder/thread/app/agent and `timingSafeEqual` (`ipc-auth-validation.ts:175-200`). The client-asserted `authToken` is still stripped before verify.
- **Response:** core signs with the per-spawn ed25519 private key (looked up by `(responseKeyId, workspaceKey, threadId)`); worker verifies with its public key; **fail-closed** if no verify key. Private key revoked on connection close (`ipc-auth.ts:189-201`).
- Because the signed `payload` bytes are identical to today, **the entire signing/auth/replay test corpus applies unchanged** to the framed payload.

### 5.5 Correlation & multiplexing

- `id` correlates `resp` to `req`. The client keeps a `Map<id, pendingResolver>` (replacing the `waitForTaskResponse` poll loop). On `resp`, resolve; on connection drop, reject all pending with a typed error (→ client retry/abandon per §6.5).
- Core keeps per-connection in-flight accounting for caps/backpressure (§10).

---

## 6. Connection lifecycle

### 6.1 Bind + single-instance election (replaces `ipc/.lock`)

- Core `bind()`s the socket path. `EADDRINUSE` ⇒ run the **ported stale-socket recovery** (the analog of `recoverStaleIpcRootLock`):
  - Try to `connect()` to the existing socket. If a live core answers a `ctrl:ping` ⇒ **another instance is alive** → do not steal, skip start (today's `pid_alive`/skip).
  - If connect fails (`ECONNREFUSED`/no listener) ⇒ socket is stale → `unlink` and rebind.
  - **PID-recycle defense preserved:** keep a sidecar lock file `core.sock.owner` with `{pid, startedAt}` and apply the existing `isRecycledPid` logic (`ps -o lstart`, 60s skew, conservative-on-uncertainty) before unlinking, so we never steal from a live sibling whose PID was recycled (`ipc-filesystem.ts:156-167`). Retry-once race guard preserved (`ipc.ts:228-240`).
- Release on shutdown: close server, `unlink` socket, remove owner file (idempotent).

### 6.2 Client connect + handshake + scope binding

1. Worker process connects to `GANTRY_IPC_SOCKET_PATH`.
2. Worker sends `ctrl:hello` carrying its **scope claim** (folder/thread/app/agent/runHandle/role∈{runner,mcp}) and a **connection credential** = the existing derived `GANTRY_IPC_AUTH_TOKEN` (HMAC, per-tuple). The hello is itself HMAC-signed with that token over a fresh nonce+expiry (reusing the request-signing path) to prove possession without sending the token in cleartext-only form.
3. Core validates: folder ∈ registry (`isValidGroupFolder`), recomputes the token for the claimed tuple, `timingSafeEqual`, binds the connection to that immutable scope, and associates it with the run (`runHandle`). Mismatch ⇒ close connection (logged).
4. Core replies `ctrl:welcome`. The connection is now usable.

- After handshake, **every frame's scope is the connection's bound scope** — the per-frame signature still recomputed/verified, and any per-frame context (chatJid for browser, userId/allowedActions for memory) cross-checked exactly as today.

### 6.3 Credential flow (env) — the three-hop chain, for BOTH clients

New env vars: `GANTRY_IPC_SOCKET_PATH` (+ the existing derived auth token already present). They must reach:

- **agent-runner:** set in the spawn env in `agent-spawn.ts:~599-625` (alongside `GANTRY_IPC_DIR`, `GANTRY_IPC_AUTH_TOKEN`, …).
- **gantry-MCP grandchild:** read from the runner's `process.env` in `query-loop.ts:309-314` → threaded into the capability context → **explicitly spread into `mcpServers.gantry.env` in `agent-capabilities.ts:266-280`** (the grandchild's env is an allow-list object, not inherited).
- **SDK CLI scrub:** add `GANTRY_IPC_SOCKET_PATH` to the delete-list in `runtime-env.ts:163-168` so the broad CLI/tool env never sees it (same posture as the existing token scrub).
- The master secret `GANTRY_IPC_AUTH_SECRET` stays **core-only** (never an env on any child) — unchanged.

### 6.4 Heartbeat / liveness

- `ctrl:ping`/`ctrl:pong` on an idle interval (e.g. 10 s) both directions. Missed N pongs ⇒ treat peer as dead, close connection. This gives **instant** death detection (vs. today's stale-file/lock heuristics).
- A dropped connection immediately rejects that connection's pending requests and frees its in-flight slots and (for the runner connection) revokes the response signing key.

### 6.5 Reconnect (in-flight handling)

- **Worker → core reconnect:** if the worker loses the connection mid-run, it redials and re-handshakes. In-flight requests that were rejected on drop are **retried with the same `requestId`** — the server-side **replay/idempotency** machinery (consumed-id set, response-exists short-circuit, in-flight dedup) makes retry safe (a duplicate that already completed returns the cached/again-signed result or is rejected as replay, never double-executed). Requests that exceed their client deadline are abandoned exactly as today.
- **Core restart:** workers detect drop, attempt reconnect with backoff; meanwhile `recoverPendingMessages` re-enqueues anything past the DB cursor on the new core. A worker that cannot reconnect within its deadline fails its current op and the run is retried via the GroupQueue (unchanged).
- **Bounded backoff + jitter** on reconnect to avoid a thundering herd at 100s scale.

### 6.6 Graceful drain / close (replaces `_close` sentinel + shutdown)

- `_close` becomes a `ctrl:drain`/`push:close` frame on the runner connection (instant, ordered) instead of a polled sentinel file. Stale-`_close`-on-restart no longer exists as a concept (no file to leak); a fresh connection starts clean.
- Shutdown: core sends `ctrl:drain` to active runner connections, waits the existing **10 s grace** (`shutdown.ts:48`), then closes. The GroupQueue shutdown path (`group-queue.ts:644-665`) is unchanged except `closeStdin` now sends a frame. **Improvement opportunity:** add the missing SIGKILL escalation after grace (today stragglers are merely detached — see §9.5 gap #2).

---

## 7. Channel-by-channel migration

Each channel keeps its exact payload, auth, and semantics; only carrier + trigger change. "Edge cases" lists what must still hold.


| #   | Channel                        | New carrier                                   | Direction   | Preserved semantics / edge cases                                                                                                                                                                                                                                       |
| --- | ------------------------------ | --------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `message`                      | `req` frame, no resp                          | MCP→core    | fire-and-forget; **folder-owns-JID authorization** (`ipc.ts:346-364`); rate-limit kind `messages`                                                                                                                                                                      |
| 2   | `task`/`mcp_*`/scheduler/admin | `req`→`resp` frame                            | MCP→core    | long-running ⇒ async resolve, no HoL block; `mcp_call_tool` still calls `recordReplyToolCall(runHandle,…)` for the latency trace (`ipc-admin-handlers.ts:360-372`); signed `appId` + same-channel target; unknown type ⇒ `resp{ok:false,code:'unsupported_task_type'}` |
| 3   | `memory`                       | `req`→`resp`                                  | MCP→core    | per-action deadline (`runWithinMemoryDeadline`); allowedActions allow-list bound in the token; memory replay key scope (`:memory:user:scope`)                                                                                                                          |
| 4   | `browser`                      | `req`→`resp`                                  | MCP→core    | **in-flight cap 4**; browser grant lifecycle (`registerBrowserIpcAuthorization`/revoke); deadline budget; forged-profile/URL rejection (handler-side, unchanged)                                                                                                       |
| 5   | `permission`                   | `req`→`resp`                                  | runner→core | **idempotent** (response-exists short-circuit → for sockets: dedup by `(scope,requestId)` + cached result); interaction cap 100; in-flight dedup key; job execution-context binding; nonce/responseNonce verify                                                        |
| 6   | `user_question`                | `req`→`resp`                                  | MCP→core    | interaction cap 100 (shared with permission); 1–4 questions/2–4 options validation; `targetJid` preservation (cross-conversation-bleed guard)                                                                                                                          |
| 7   | `continuation`                 | `push` frame                                  | core→runner | **per-conversation ordering** via monotonic seq in frame; delivered at runner turn-boundary via the **unchanged** `SteeringDeliveryGate`; the in-process `continuationHandler` nudge is replaced by the frame itself                                                   |
| 8   | `close`                        | `ctrl`/`push`                                 | core→runner | ends the stream like `shouldClose()`; no stale-file leakage                                                                                                                                                                                                            |
| 9   | `live_tool_rules`              | `push` (core→worker) **+ request-on-connect** | core→worker | core pushes rule updates; on connect the worker requests the current snapshot so a tool decision never races a missing push. Read on every `canUseTool` becomes a local cache updated by pushes (faster than today's per-decision file read)                           |
| 10  | `interaction_boundary`         | **DECISION D2** (see §15)                     | MCP→runner  | delete-to-ack flush handshake; bounded 2 s wait                                                                                                                                                                                                                        |


**D2 options for the worker-internal interaction-boundary:** (a) **keep on filesystem** for now — it's rare (only on `ask_user_question`), latency-tolerant, and not on the reply hot path; lowest risk, smallest blast radius; (b) **relay via core** (MCP→core→runner) for a single uniform transport; (c) a **direct runner↔MCP socket**. Recommendation: **(a) for the first cutover**, revisit in a follow-up once the hot-path channels are proven. This keeps Pillar 1 focused on the latency wins (channels 2 and 7) without dragging an interactive-only handshake into scope.

---

## 8. Security parity matrix

Every guarantee, its current anchor, and how the socket transport replicates it. (Source: security inventory.)


| Guarantee                                                                                                                                | Current anchor                                                                             | Socket transport replication                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Master secret never leaves core                                                                                                          | `agent-spawn.ts:87-115,572-636`; `source-classification.ts:30`                             | Unchanged. Only derived tokens flow; socket path is non-secret; SDK-CLI env scrub extended to the new var                                                        |
| Request integrity = HMAC over full payload, channel-keyed, **server-recomputed**, constant-time                                          | `signing.ts:4-13`; `ipc-auth.ts:51-138`; `ipc-auth-validation.ts:175-200`                  | Reuse functions verbatim on the framed `payload`; recompute key from the **connection's bound scope**; ignore client-asserted token                              |
| Response integrity = ed25519, private key core-only, per-spawn rotation, fail-closed, revoke on exit                                     | `response-signing.ts:12-37`; `ipc-auth.ts:161-201`                                         | Unchanged signing; key bound to the connection; revoked on connection close                                                                                      |
| Replay defense = nonce + 5-min expiry + single-use scoped requestId set + TTL prune                                                      | `request-signing.ts:30-62`; `ipc-auth-validation.ts:155-292`                               | Kept. **A persistent connection does not remove replay risk** (a malicious in-process actor could resend a frame); the consumed-id set stays                     |
| Symlink/ownership hardening (0o700/0o600, lstat asserts)                                                                                 | `private-fs.ts:7-45`; `ipc-filesystem.ts:20-27`                                            | Applied to the socket file + owner lock; `0o700` dir is the primary isolation (only core's uid can open the socket); optional peer-uid check as defense-in-depth |
| Per-(folder,channel) rate cap 300/60 s + 100 interaction in-flight + 4 browser in-flight                                                 | `ipc-rate-limit.ts`; `ipc.ts:33`; `ipc-browser-requests.ts:28`                             | Kept as explicit per-connection-scope counters (not replaced by raw backpressure)                                                                                |
| Single-instance + PID-recycle-aware stale recovery (conservative)                                                                        | `ipc-filesystem.ts:156-214`; `ipc.ts:191-246`                                              | Ported to `EADDRINUSE` + connect-probe + owner-file `lstart`/skew logic                                                                                          |
| Authorization scoping (folder-owned JIDs, context↔payload coherence, signed appId, same-channel target, job exec-context, browser grant) | `ipc.ts:107-158,346-364`; `ipc-auth-validation.ts:89-153`; `ipc-admin-handlers.ts:118-498` | Recompute scope server-side from the connection binding; never trust peer identity claims; all handler-side checks unchanged                                     |


**Two invariants restated as acceptance gates:** (1) core recomputes/derives identity, keys, and the response key from the spawn-time binding — client claims are stripped or rejected; (2) responses are asymmetric (worker cannot forge even on its own connection). A reviewer should be able to point at the test that proves each.

---

## 9. Robustness & recovery

### 9.1 Failure of a single request

Bad/oversized/over-rate frame ⇒ reject that frame (typed `resp{ok:false}` so the client unblocks immediately, mirroring `writeTaskIpcResponse({ok:false})` before archive at `ipc.ts:56-65`) + structured quarantine log (analog of `archiveIpcErrorFile`). One bad frame never aborts the connection's other in-flight work; one bad connection never affects others.

### 9.2 Retries

Unchanged: agent-run retries live in GroupQueue with exponential backoff `5s→10s→20s→40s→80s`, max 5, reset on success, suppressed during shutdown (`group-queue.ts:534-555`). Transport-level reconnect is separate (§6.5) and bounded.

### 9.3 Crash recovery (durability)

- **Core restart:** `recoverPendingMessages` re-scans the DB per conversation/thread from the persisted cursor and re-enqueues (`message-loop.ts:425-457`). **Unchanged.** The cursor advances only after a batch is handled, so no committed message is lost.
- **Worker crash:** core detects the connection drop instantly (vs. today's stale files), frees in-flight slots, revokes the response key, and the run is retried via GroupQueue. No orphaned `.processing-` files (a current gap — see §9.5).

### 9.4 The reconciliation backstop (belt & suspenders)

The socket is the fast path; a **slow safety net** guarantees no lost work if a frame is ever dropped or a connection silently wedges:

- Keep `recoverPendingMessages` running at boot (already).
- Add a **low-frequency reconciliation tick** (e.g. every few seconds, configurable) that re-enqueues DB-pending conversations whose runner connection is idle/absent — i.e. the existing message-loop, retained but at a *long* interval purely as a safety net, not the delivery mechanism. This is the explicit "doorbell + occasional rounds" design.
- During migration, the filesystem path remains available as the ultimate fallback (§14).

### 9.5 Gaps we can improve — OPT-IN, flag-gated (operator-approved; catalogued in §20)

> Operator (2026-06-15): opting these in is fine. They are **not bundled into the equivalence-guaranteed carrier swap** (the default shipped behavior stays identical), but they are welcome as **opt-in, flag-gated improvements** — each default-off and separately acceptance-tested. The three below touch only crash/shutdown/recovery edges, so the §19 runbook passes identically whether they are ON or OFF. Full catalogue (with flags + acceptance) in §20.

The current system has three known weaknesses the socket design can remove:

1. **Orphaned `.processing-…` claimed files** after a core crash mid-handle (never swept) — gone, since there are no claim files; in-flight state is connection-bound and cleared on drop.
2. **No SIGKILL escalation after the 10 s shutdown grace** — add it (kill stragglers after grace) so shutdown is deterministic.
3. **In-memory replay/in-flight/rate state reset on restart** — document and (optionally) make the consumed-id window survivable; at minimum, the 5-min `expiresAt` bound limits exposure (unchanged risk profile, called out for review).

---

## 10. Backpressure & concurrency (the 100s-ready part)

- **Per-connection in-flight cap** with a bounded queue; when exceeded, the server applies backpressure (stops reading that connection / signals `ctrl:busy`) instead of unbounded growth — the death-spiral protection a filesystem mailbox lacks.
- **Preserve the explicit caps** as policy (not replaced by socket buffers): `MAX_MESSAGE_RUNS=3`, `MAX_JOB_RUNS=4`, interaction 100, browser 4, rate 300/60 s. These remain in GroupQueue / the channel handlers.
- **Fairness:** round-robin / per-connection accounting so one chatty conversation cannot starve others — a stub now (single conversation), but the accounting hooks ship so Pillar-2 can set policy without re-plumbing.
- **Cost model:** server work ∝ frames received, not ∝ conversations registered. No periodic scan of N directories. This is the concurrency win that motivated B.

---

## 11. Edge-case catalog (exhaustive — each must have a test in §13)

Transport/framing:

1. Frame split across multiple `read`s; multiple frames in one `read`; zero-length read.
2. Oversized frame (> max) ⇒ reject + quarantine + (for req) `resp{ok:false}`.
3. Truncated/never-completing frame ⇒ bounded reset.
4. Malformed JSON body ⇒ reject one frame, connection survives.
5. Unknown `channel`/`type`/`v` ⇒ reject with typed error (no crash).
6. Wrong-channel payload (e.g. browser-signed payload sent on `permission` channel) ⇒ rejected by recomputed-key mismatch.

Auth/security:
7. Unsigned / tampered request ⇒ reject (HMAC mismatch).
8. Expired (`expiresAt`) / missing-nonce / malformed `requestId` ⇒ reject.
9. Replay of a valid `requestId` within TTL ⇒ reject.
10. Forged scope in `ctrl:hello` (folder/app/agent/thread not matching the derived token) ⇒ handshake rejected.
11. Response with wrong `requestId` / bad ed25519 signature / missing verify key ⇒ worker discards, fail-closed.
12. Connection from a non-core uid ⇒ blocked by the `0o700` dir (primary); peer-uid mismatch ⇒ refused where the platform helper is available (defense-in-depth).
13. Cross-conversation: a connection bound to conv A cannot deliver/act on conv B (folder-owned-JID + `targetJid` checks).

Lifecycle/recovery:
14. `EADDRINUSE` with a **live** core ⇒ second instance refuses to start.
15. `EADDRINUSE` with a **dead** core (stale socket) ⇒ recovered + rebind.
16. `EADDRINUSE` with a **PID-recycled** owner ⇒ recovered (lstart/skew); with an **uncertain** owner ⇒ NOT stolen (conservative).
17. Worker connection drop mid-request ⇒ pending rejected, slots freed, key revoked; run retried.
18. Core restart mid-conversation ⇒ workers reconnect; `recoverPendingMessages` replays from cursor; no lost/duplicated message.
19. Reconnect with an in-flight `requestId` that already completed ⇒ idempotent (no double-execute).
20. Graceful drain: `ctrl:drain` ends the stream; 10 s grace; then close (and SIGKILL stragglers — new).
21. Stale `_close` no longer possible (no file).

Ordering/concurrency:
22. Continuation FIFO within a conversation under same-millisecond bursts (seq tiebreaker preserved).
23. Per-conversation isolation: concurrent customers never bleed into each other's session.
24. Long-running op (`mcp_call_tool`, permission wait) does not block other in-flight requests on the same connection.
25. In-flight cap reached ⇒ backpressure, not unbounded growth; no starvation across connections (fairness hook).
26. Rate limit 300/60 s per (scope,channel) still enforced; bad frames don't charge the authorized bucket (current behavior preserved).

Trace/observability:
27. `mcp_call_tool` still records the per-reply `ToolCallRecord` (latency trace intact).
28. Reply-trace window/section assembly unaffected (the timestamps it reads are unchanged; only delivery is faster).

---

## 12. Observability

- **Structured logs** per connection: handshake (scope, role), each frame (channel, id, bytes, ms), rejects (reason), drops, reconnects, backpressure events, stale-socket recovery decisions (mirroring the current lock-recovery logs).
- **Metrics** (counters/histograms): frames in/out per channel, in-flight gauge, request latency per channel, reject/drop/reconnect counts, backpressure activations. These directly validate the §1.1 latency targets.
- **Latency trace intact:** `recordReplyToolCall` continues to fire from the `mcp_call_tool` handler; the v2 reply-trace timeline (`assembleTimeline`) is unaffected because it reads message/turn timestamps, not IPC mechanics. We will re-capture the two reference traces after each cutover to prove the `queue`/`gap` reductions.

---

## 13. Test plan (the core of "no shortcuts")

Strategy: **reuse** the excellent existing unit/signing/handler/isolation tests almost verbatim against the new client; **add** a transport-loop integration layer and a **net-new** load/failure-injection layer (the systematic gaps the current suite never covered). Runner: vitest; harnesses listed are existing and reusable.

### 13.1 Reused unchanged (crypto/handler/parser/isolation)

Because payloads are byte-identical, these apply to the framed payload with at most a thin adapter:

- `ipc-auth-token.test.ts`, `ipc-auth-secret-source.test.ts`, `ipc-request-signing.test.ts`, `ipc-auth-boundary.test.ts` (the 1065-line boundary corpus: signed/fresh accept, tamper/expired/replay reject, per-channel parser hardening, response-key lifecycle, job exec-context).
- `ipc-interaction-handler.test.ts` (signed responses, file modes, live-rule writing, secret redaction).
- `continuation-input.test.ts` (per-conversation isolation), `steering-delivery-gate.test.ts` (turn-boundary buffering), `user-question-payload.test.ts` (targetJid guard).
- `reply-trace*.test.ts`, `mcp-trace-capture.test.ts` (trace capture intact).
- `group-queue.test.ts` (concurrency caps, backoff, shutdown, FIFO) — the queue is unchanged; only `sendMessage`/`closeStdin` internals (frame vs file) get re-pointed; keep its FIFO + concurrency assertions.

### 13.2 New: framing/protocol unit tests

- Encode/decode round-trip; split/coalesced reads; zero-length reads; **property test** that any byte-split of a stream of frames decodes identically (fast-check style).
- Oversized frame, truncated frame, malformed JSON, unknown channel/type/version → typed errors, connection survives where specified.
- Envelope schema validation (every `channel`/`type`).

### 13.3 New: transport-loop integration (the biggest current gap)

A test harness that stands up a **real core socket server** + **fake worker client(s)** (and vice versa), exercising accept → handshake → dispatch → response across all channels. This is the analog of the untested `processIpcFiles` loop.

- Handshake success/failure (forged scope, bad token, unknown folder, peer-uid mismatch).
- Each channel end-to-end: continuation push delivered + ordered; `mcp_call_tool` req→resp with `recordReplyToolCall` assertion; memory/browser/permission/user-question round-trips; `messages` fire-and-forget + folder-owned-JID authz; live-tool-rules push + on-connect snapshot.
- Long-running op concurrency (one slow `mcp_call_tool` doesn't block a second req on the same connection).

### 13.4 New: single-instance + stale-socket recovery

- `EADDRINUSE` + live core (ping answered) ⇒ refuse; + dead core ⇒ rebind; + PID-recycled owner ⇒ rebind; + uncertain owner ⇒ refuse (conservative). Reuse the `ps lstart`/skew logic and its (currently untested!) decision table.

### 13.5 New: failure-injection matrix

For each of: connection drop before/after handshake, drop mid-request, drop after request-before-response (orphan response → reply to closed connection is discarded), core restart mid-conversation, worker restart with in-flight requestId (idempotent), reconnect storm.

- Assert: no double-execute (idempotency), no lost work (DB-cursor replay), pending rejected promptly, slots/keys freed, response key revoked on drop.

### 13.6 New: ordering & isolation under concurrency

- Same-millisecond continuation burst → FIFO preserved (seq tiebreaker).
- N concurrent conversations interleaved → each conversation's continuation order intact; zero cross-conversation bleed.

### 13.7 New: backpressure / load (nothing covers this today)

- N concurrent client connections, M requests each → throughput, latency distribution, fairness (no starvation), in-flight cap honored, rate-limit 300/60 s honored, backpressure activates instead of unbounded memory growth.
- Flood of bad frames does not charge the authorized rate bucket (port `ipc-browser-requests.test.ts` behavior).
- Soak test: sustained traffic for a duration with no FD/memory leak (connections cleaned up on drop).

### 13.8 New: real-child end-to-end (highest fidelity)

Extend the existing spawned-child harnesses (`agent-runner-ipc.test.ts` `createRunnerFixture`, `ipc-mcp-stdio.test.ts` `createMcpFixture`) to run the **real runner and real gantry-MCP** against the **real core socket server** with the fake model SDK, proving the env-credential three-hop (§6.3) actually reaches both clients and the SDK-CLI scrub holds.

### 13.9 Coverage gate

Every row in §11 maps to at least one test above. A reviewer checklist (§11 number → test name) ships with the implementation PR.

---

## 14. Migration / rollout plan (safe, reversible)

**Principle:** dual-stack with a feature flag; cut over one channel at a time; validate each with the two reference traces; instant fallback.

1. **Build the transport behind a flag** (`GANTRY_IPC_TRANSPORT = 'fs' | 'socket' | 'dual'`, default `fs`). In `dual`, core runs both the socket server and the file watcher; clients prefer socket, fall back to file on connect failure.
2. **Phase 1 — hot path (the latency win):** cut over `continuation` (channel 7/8) and `task`/`mcp_*` (channel 2). These alone deliver the `queue` + `gap` reductions. Re-capture the two traces; confirm targets in §1.1.
3. **Phase 2 — request/response channels:** `memory`, `browser`, `permission`, `user_question`, `messages`, `live_tool_rules`.
4. **Phase 3 — decide D2** for `interaction_boundary` (keep FS or relay).
5. **Phase 4 — remove the file watcher** once socket is proven in production for a soak period; keep `recoverPendingMessages` + the slow reconciliation backstop forever.
6. **Rollback:** flip the flag to `fs`; the file watcher and all current code remain intact until Phase 5. Because payloads/handlers are shared, `fs` and `socket` are behaviorally equivalent at the handler boundary.
7. **Validation artifact:** before/after reply-latency reports for "hey boondi" (cold) and "do you have kaju katli?" (warm), proving `queue`/`gap` collapse with no change to security/trace behavior.

---

## 15. Open decisions for review (the genuine forks, GO AHEAD WITH Recommendations.)

- **D1 — socket granularity:** one shared core socket + per-connection scope (recommended) vs. one socket per group. Shared = simpler election/recovery, natural multiplexing; per-group = stronger filesystem-level isolation but N sockets to manage and recover. *Recommendation: shared.*
- **D2 — interaction-boundary (channel 10):** keep on filesystem (recommended for first cutover; rare, interactive, off hot path) vs. relay via core vs. direct runner↔MCP socket.
- **D3 — connection credential:** reuse the existing derived `GANTRY_IPC_AUTH_TOKEN` as the handshake proof (recommended — zero new secret surface) vs. mint a dedicated short-lived connection token.
- **D4 — replay window durability (gap #3):** leave in-memory (current risk profile, bounded by 5-min expiry) vs. persist the consumed-id window so a core restart can't admit a replay within `expiresAt`.
- **D5 — shutdown SIGKILL escalation (gap #2):** add deterministic kill-after-grace now, or keep detach-and-recover. *Recommendation: add it.*
- **D6 — backpressure signal:** silent (stop reading the socket) vs. explicit `ctrl:busy` so the client can choose to wait vs. shed. *Recommendation: explicit, for observability.*

---

## 16. File-by-file change map (for concrete review)

**New (core):**

- `runtime/ipc-socket-server.ts` — bind/election/stale recovery, accept, per-connection state, dispatch to existing handlers, backpressure.
- `runtime/ipc-frame.ts` — length-prefix framing encode/decode (+ max-frame).
- `runtime/ipc-connection.ts` — per-connection scope binding, in-flight map, heartbeat, drain.

**New (worker, both clients):**

- `runner/mcp/ipc-socket-client.ts` and `adapters/.../runner/ipc-socket-client.ts` — connect/handshake/reconnect, request/response correlation (replaces the poll loops in `runner/mcp/ipc.ts` and the file reads in `runner/.../ipc-input.ts`), shared framing.

**Modified:**

- `runtime/ipc.ts` — gate the watcher behind the flag; share the dispatch routing with the socket server (extract the per-channel handlers so both carriers call the same functions).
- `runtime/group-queue.ts` — `sendMessage`/`closeStdin` send frames in `socket` mode (continuation/close) instead of writing files; concurrency model unchanged.
- `runtime/agent-spawn.ts` (+ `agent-capabilities.ts`, `runner/.../runtime-env.ts`) — thread `GANTRY_IPC_SOCKET_PATH` to runner + MCP env; extend the SDK-CLI env scrub.
- `runner/mcp/ipc.ts`, `runner/mcp/tools/{service,messaging}.ts`, `adapters/.../runner/{ipc-input,permission-callback,query-loop}.ts` — call the socket client in `socket` mode; keep file path under the flag.
- `config/index.ts` / settings — add `GANTRY_IPC_TRANSPORT` + socket path + intervals.

**Unchanged (reused):** `ipc-auth*.ts`, `infrastructure/ipc/*signing.ts`, `runner/mcp/signing.ts`, `ipc-parsing.ts`, `ipc-task-parsing.ts`, `ipc-rate-limit.ts`, `ipc-admin-handlers.ts` and all task handlers, `memory-ipc.ts`, `ipc-browser-handler.ts`, `ipc-interaction-processing.ts`, `message-loop.ts` recovery, `steering-delivery-gate.ts`, reply-trace.

---

## 17. Appendix — authoritative source references

(Each claim in this spec is grounded in these, per the read-only inventory pass on 2026-06-15.)

- Core watcher & channels: `apps/core/src/runtime/ipc.ts`, `ipc-filesystem.ts`, `ipc-parsing.ts`, `ipc-task-parsing.ts`, `ipc-rate-limit.ts`, `ipc-interaction-processing.ts`, `ipc-browser-requests.ts`; `jobs/ipc-handler.ts`, `ipc-admin-handlers.ts`, `ipc-shared.ts`; `memory/memory-ipc.ts`.
- Worker/client & lifecycle: `runner/mcp/ipc.ts`, `ipc-ids.ts`, `context.ts`, `stdio.ts`, `tools/service.ts`, `tools/messaging.ts`; `adapters/llm/anthropic-claude-agent/runner/{ipc-input,runtime-env,steering-delivery-gate,permission-callback,query-loop}.ts`; `runtime/continuation-input.ts`, `group-queue.ts`, `agent-spawn.ts`, `agent-spawn-process.ts`, `agent-spawn-layout.ts`, `agent-capabilities.ts`.
- Security: `runtime/ipc-auth.ts`, `ipc-auth-validation.ts`; `infrastructure/ipc/{request,response}-signing.ts`; `runner/mcp/signing.ts`, `adapters/.../runner/ipc-signing.ts`; `shared/private-fs.ts`.
- Failure/recovery: `runtime/message-loop.ts`, `group-queue.ts`, `group-queue-stop.ts`, `app/bootstrap/{runtime-services,shutdown}.ts`; `config/index.ts`.
- Tests & harnesses: `apps/core/test/unit/{runtime,runner,core,jobs}/…`, `apps/core/test/integration/…`, `apps/core/test/harness/…`.

---

## 18. Behavioral equivalence & test compatibility (HARD ACCEPTANCE GATE)

**Operator requirement:** at the user level, Gantry core works exactly as today — no breaks, no new errors, no behavior change — and the existing user-/functionality-focused tests pass. Functionality is identical; only the carrier changes. This section is the binding gate for every cutover.

### 18.1 How users are protected by construction

- **Default `fs`, additive socket.** `GANTRY_IPC_TRANSPORT` defaults to `fs`. Until a channel is deliberately cut over, the socket code is dormant; user behavior and the **entire current test suite are unaffected, byte-for-byte**.
- **Same handlers, same payloads.** Both carriers call the *same* parser/auth/handler functions on the *same* signed payloads. Every user-facing result is produced by unchanged code.
- **Per-channel, reversible cutover.** Flip one channel to `socket`; if anything differs, flip it back instantly.

### 18.2 Test taxonomy — what passes unchanged vs. what gets a socket-mode twin

**A. Functional / user-behavior tests — pass UNCHANGED (carrier-independent).** auth/signing/replay (`ipc-auth-boundary`, `ipc-auth-token`, `ipc-request-signing`), handler behavior + redaction + response file-mode (`ipc-interaction-handler`), parser hardening, GroupQueue concurrency/backoff/shutdown/FIFO *semantics*, message-loop routing/recovery/guardrail (`message-loop`), reply-trace (`reply-trace*`, `mcp-trace-capture`), steering gate, per-conversation isolation *intent*. These assert WHAT happens, not the carrier.

**B. Carrier-coupled tests — assert the filesystem mechanism; handled by dual-stack.** the `vi.mock('fs')` write assertions in `group-queue.test.ts` (`_close`/continuation file writes), the file request/response client tests (`mcp-ipc`, `browser-ipc-signature`), the real-child file-exchange harnesses (`agent-runner-ipc`, `ipc-mcp-stdio`), fs trust/symlink (`ipc.test.ts`), continuation *dir-path* tests. These **keep passing while default is `fs`**; for `socket` mode we add parallel equivalents (same behavioral assertions, socket carrier). **None are deleted — coverage only grows.**

> Honest statement of the contract: this is **not** "zero tests change." It is "**zero user-facing behavior changes; the functional corpus stays green; the only tests that move are the ones deliberately coupled to the old plumbing, and they get a socket-mode twin, not a deletion.**"

### 18.3 The strongest guarantee — conformance (differential) testing

Parametrize the behavioral suite over the transport: run the **same** functional tests with `GANTRY_IPC_TRANSPORT=fs` and `=socket`, asserting **identical observable outcomes** (same replies, same ordering, same error surfaces, same trace records). Green under **both** carriers is machine-checked proof of equivalence, and is the gate a channel must pass before cutover.

### 18.4 User-observable invariants (each with its proof)

1. A customer message always gets exactly one correct reply (no loss, no duplicate) — DB-cursor recovery + idempotency; conformance test under both carriers.
2. Reply ordering within a conversation is preserved — seq tiebreaker + single-connection stream order; same-millisecond burst test.
3. Interactive flows (permission, `ask_user_question`) round-trip identically — unchanged payloads/handlers; real-child conformance test.
4. Guardrail / safety / leak-redaction decisions are unchanged — carrier-independent handler code.
5. Error surfaces are identical — socket faults are absorbed (retry/reconnect/reconcile) and never produce a *new* user-visible error vs. the fs path.
6. Tool calls produce identical results and trace records — `recordReplyToolCall` intact.

### 18.5 Behavior-change RISKS this review caught — scoped OUT of the equivalence core

Places where "faster" could *accidentally* change behavior. Each is excluded from the guaranteed-equivalent carrier swap; if pursued, it ships separately behind its own gate and conformance proof.

- **R1 — message-loop poll removal changes batching (the ONE genuinely user-facing risk).** Today, rapid messages within a ~500 ms tick are batched into one prompt (`getMessagesSince` + `MAX_MESSAGES_PER_PROMPT` → `formatMessages`, `message-loop.ts:259-329`; inbound on an active group only sets `pendingMessages`, `group-queue.ts:216-217`). Event-triggering the pipe per message could split them into separate turns → different replies. Unlike R4, this touches the **user-facing happy path**. It is **opt-in (§20 I-R1) with a hard sub-requirement: it MUST preserve the batch window** (a debounce reproducing the current ~500 ms batching) so the §19 runbook stays green. The equivalence core (carrier swap only) does **not** include it. This is why §1.1's warm-`queue` target is split: ~250–300 ms (carrier swap, behavior-identical) → <50 ms (this opt-in phase, batching preserved).
- **R2 — `live_tool_rules` push+cache could serve stale rules.** Mitigation (equivalence-required): keep a **read-through fallback** to the authoritative source on every tool decision, so a missed push can never change a permission outcome.
- **R3 — faster delivery exposing latent timing assumptions in tests.** Some carrier-coupled tests may implicitly rely on poll delays. Fixed in the tests via condition-based waiting — never by artificially slowing the transport.
- **R4 — the §9.5 improvements (SIGKILL-after-grace, orphan-file removal, replay-window persistence) — OPT-IN (operator OK'd).** Not bundled into the equivalence core (the default shipped behavior stays identical), but available as flag-gated, default-off improvements, each separately acceptance-tested (§20). These touch only crash/shutdown/recovery edges — never the user-facing happy path — so the §19 runbook passes identically whether they are ON or OFF.

### 18.6 Definition of done for a cutover

The binding gate is the **E2E acceptance criteria in §19** (the operator's single acceptance criteria). The functional suite (§18.2) and conformance suite (§18.3) are *supporting* dev-time verification — but a channel is ACCEPTED for `socket` in production only when the full §19 E2E run passes **identically to the `fs` baseline**, plus the reference traces show the latency win with no other delta and a soak shows no new error/loss/reorder. The fs path is not removed until §14 Phase 5, after a full production soak.

---

## 19. Acceptance criteria — Boondi E2E via `docs/BOONDI-E2E-TESTING.md` (THE ONLY GATE)

**Single, definitive acceptance criteria (operator, 2026-06-15):** Pillar 1 is accepted only if **Boondi behaves exactly as it does today** when driven end-to-end through the runbook — a real signed Interakt webhook, full message processing through every layer, and **every command** — proven in the admin panel. "Just like how it works currently." Everything else in this spec serves this gate.

### 19.1 Method — baseline `fs`, then `socket`, identical results

1. On `GANTRY_IPC_TRANSPORT=fs` (today's behavior) run the §19.3 + §19.4 checklist and **record** replies / timings / records / memory as the baseline.
2. On `socket` mode (per channel, as it is cut over) run the **same** checklist.
3. **Accept only if results are identical** — same replies, same ordering, same delivery behavior, same records/memory, latency same-or-better. Any difference ⇒ not accepted, stay on `fs`.

### 19.2 Preflight (runbook §2–§3, §10) — safety, non-negotiable

- Stack up: core `:4710`, shopify `:8081`, boondi-crm `:8082`, admin `:3000` (health one-liner).
- `GANTRY_OUTBOUND_DRYRUN=1` + operator phone list confirmed on the **live** core process (not just the `.env` file).
- Dev mode only (`npm run dev`), never launchd; send only from FAKE listed numbers; never `DRYRUN=0`.

### 19.3 Message-processing scenarios (signed webhook → full pipeline → admin-panel proof)

Each turn sent via `scripts/lib/webhook.mjs` (or the raw signed curl), HMAC over exact bytes, 200 ACK, then poll every 5 s (chat ≤50 s; commands ≤2 min).


| #   | Scenario                          | Input                                                     | Expected (must equal `fs` baseline)                                                               | Pillar-1 seam it exercises                                    |
| --- | --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| S1  | Guardrail `direct_response`       | bare "hi" from a fresh fake (e.g. `000000904`)            | canned greeting ~0.7 s, **no agent spawn**, inbound + outbound both visible in admin              | guardrail (carrier-independent — proves no collateral change) |
| S2  | Guardrail allow → agent → Shopify | "Do you have kaju katli?" from fake (e.g. `000000905`)    | sonnet agent → `mcp_call_tool` → shopify-api → real catalogue reply, persisted + in admin (~21 s) | **the `gap` seam** (`mcp_call_tool` IPC → core proxy)         |
| S3  | CRM tool                          | a turn that drives `get_open_records`                     | boondi-crm result reflected in the reply                                                          | the `gap` seam (boondi-crm)                                   |
| S4  | Warm follow-up                    | a 2nd message in S2's conversation while it is still warm | correct contextual reply, correct **ordering**, no bleed                                          | **the warm `queue` seam** (continuation `input`)              |
| S5  | Concurrency / isolation           | `scripts/boondi-isolation.mjs` (concurrent users)         | no cross-chat bleed; per-conversation ordering preserved                                          | continuation isolation + ordering                             |


### 19.4 Commands (runbook §6c) — every one, from an operator-listed number, exact replies


| Command                  | Expected reply (must match)                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/new`                   | `Started a fresh session.` (failure: `/new failed. The session is unchanged.`)                                                           |
| `/digest-session`        | `Digest processed. New digest: yes` + `Memory facts saved: N.`                                                                           |
| `/extract-leads-queries` | ack `Running lead/query extraction…`, then `Lead/query extraction processed. Extracted: N. Created: N. Updated: N. Skipped: N.` (≤2 min) |
| `/commands`              | the help list (built-ins + agent commands)                                                                                               |
| `/stop`                  | `Stopping current run.` / `No active run to stop.`                                                                                       |


Commands ride the same **task** and **continuation** IPC channels Pillar 1 replaces, so they are first-class acceptance, not an afterthought. (`/stop` in particular exercises the close-signal path.)

### 19.5 Background extraction (runbook §6c)

Driven via `/digest-session` + `/extract-leads-queries` (don't wait for idle timers): a digest row appears (`gantry.agent_session_digests`), memory facts land (`gantry.memory_items` / `/api/memory?phone=…`), and a CRM record is created (`boondi_crm.boondi_business_records` / `/api/records`) — identical to baseline.

### 19.6 Proof of record (runbook §7)

**Every test conversation must appear in the admin panel, both directions — that is the proof.** If the panel shows nothing, the test did not pass, whatever the logs say. Assert via `/api/messages`, `/api/records`, `/api/memory`.

### 19.7 Automated form of this gate (runbook §8)

The runbook's harnesses automate the above and are run **under both carriers**:

- `node scripts/boondi-regression.mjs` (conversation, shopify, crm groups) → S1–S3 + the command flows.
- `node scripts/boondi-isolation.mjs` (concurrent users, cross-chat bleed) → S5; the strongest ordering/isolation check, and the most important one for the eventual concurrency phase.
- `node scripts/measure-latency.mjs` → proves the `queue`/`gap` win **with no behavioral delta**.

Green on `fs`, then green-and-identical on `socket`, for each channel = accepted. This replaces the abstract "definition of done" — §19 *is* the definition of done.

---

## 20. Opt-in improvements (flag-gated, default-off)

Operator approved opting these in (2026-06-15). Each is **additive, behind its own flag, default-off**, and individually acceptance-tested. Layered **on top of** the equivalence core, not part of it.

**Hard invariant:** with every improvement flag OFF, the system is exactly the behavior-identical carrier swap that passes §19 against the `fs` baseline. Turning an *edge-only* improvement ON must still pass §19 **identically** (it doesn't touch the runbook's surface). The one *user-facing* improvement (I-R1) must pass §19 **with batching preserved**; if instead we ever choose to accept a batching change, that is a deliberate, separately-signed-off re-baseline — never a silent default.


| ID       | Improvement                                                 | Proposed flag               | What changes                                                                                                                 | Acceptance / why it's safe to opt in                                                                                                                                                                                                                             |
| -------- | ----------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I-R1** | Message-loop event-trigger → full warm-`queue` win (<50 ms) | `GANTRY_IPC_EVENT_PIPE`     | inbound continuation piped on arrival instead of waiting for the 500 ms tick                                                 | **User-facing → strictest gate.** MUST preserve batching via a debounce reproducing the ~500 ms window. Acceptance: §19 green, esp. S4 (warm follow-up) **plus a new rapid-burst case** proving two fast messages still batch into one reply, identical to `fs`. |
| **I-1**  | SIGKILL stragglers after the 10 s shutdown grace            | `GANTRY_IPC_SHUTDOWN_KILL`  | deterministic kill of runs still alive after grace (today: detached, left to next-boot recovery)                             | Crash/shutdown edge only. §19 unaffected (runbook never exercises post-grace stragglers). Acceptance: a dedicated shutdown test; §19 still identical with it ON.                                                                                                 |
| **I-2**  | Sweep orphaned in-flight state on boot                      | `GANTRY_IPC_ORPHAN_SWEEP`   | reclaim work a crash left mid-handle (today: orphaned `.processing-` files never swept)                                      | Recovery edge only. §19 unaffected. Acceptance: a crash-recovery test; strictly more robust, no happy-path change.                                                                                                                                               |
| **I-3**  | Persist the replay window                                   | `GANTRY_IPC_REPLAY_PERSIST` | a captured request can't be replayed across a core restart within its 5 min `expiresAt` (today: in-memory, reset on restart) | Security edge only. §19 unaffected. Acceptance: a restart-replay test.                                                                                                                                                                                           |


Sequencing: ship the equivalence core first (passes §19 identically), then enable these **one at a time**, each its own reviewed change with its own acceptance. None of them gate or delay the behavior-identical default. I-1/I-2/I-3 can go in any order; **I-R1 is the only one that needs the rapid-burst batching test before it flips.**