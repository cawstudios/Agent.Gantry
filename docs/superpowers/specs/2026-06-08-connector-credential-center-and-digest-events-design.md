# Connector → Credential Center + Event-Driven CRM Trigger — Design

**Goal:** Remove OneCLI from Gantry entirely (the `mcp-crm` connector is the last user) by having the connector resolve its model credential from the same Credential Center core uses, and make the connector react to new session digests via a Postgres event instead of a 4-minute timer.

**Architecture:** Two independent pieces, landed in order. Piece 1 retires OneCLI: a new shared crypto package lets the connector read+decrypt the Anthropic credential from `model_credentials` and project `CLAUDE_CODE_OAUTH_TOKEN` (exactly as core's gateway does). Piece 2 makes core emit a `digest.session-end` runtime event on digest write and the connector `LISTEN` for it, demoting its cursor poll to a slow backstop.

**Tech stack:** TypeScript monorepo (npm workspaces), Postgres (`pg` + Drizzle in core), Node `crypto` (AES-256-GCM), Postgres LISTEN/NOTIFY, Claude Agent SDK.

**Decisions locked with the user:** shared crypto module (not copy); reviewed merge committed first (done — base is `2ace5bfe`).

---

## Background / current state (verified)

- Core's model auth is the in-process **Gantry Model Gateway**; the Anthropic credential lives encrypted in `model_credentials` (`payloadEncrypted`, mode `claude_code_oauth`, field `oauthToken`), AES-256-GCM, format `gcred:v2:…`, decrypted with `SECRET_ENCRYPTION_KEY` (present in `~/gantry/.env`). The gateway's projection for OAuth is literally `{ CLAUDE_CODE_OAUTH_TOKEN: token }` — no proxy/CA (`gantry-model-gateway.ts:645`).
- The connector (`packages/mcp-crm`) still uses OneCLI (`onecli-bootstrap.ts`, `@onecli-sh/sdk`) to fetch a token+proxy+CA and set `CLAUDE_CODE_OAUTH_TOKEN`. It has `pg` + the same DB. It is the only remaining OneCLI user (core has none).
- Core's digest write (`saveAgentSessionDigest`, repository layer) emits **no** event today. The CRM watcher only timer-polls `agent_session_digests` via the `boondi_digest_cursor` watermark (`watcher/index.ts:85`, default 240 000 ms).
- A durable runtime-event path exists: `RuntimeEventExchange.publish()` → `appendRuntimeEvent` (writes `runtime_events` **and** `event_bus_outbox` in one tx) → `pg_notify('gantry_runtime_events', wakeup)`. The wakeup payload is `{eventId, appId, complete, conversationId, sessionId, eventType, …}`, truncated to a pointer if >7500 bytes.

---

## Piece 1 — Connector resolves its credential from the Credential Center

### 1a. New shared package `@gantry/credential-crypto`

Move the security-critical crypto out of `apps/core` into a small workspace package both core and the connector import, so the encrypt/decrypt format and AAD can never drift.

- **Create** `packages/credential-crypto` (package.json, tsconfig, build like the other `@gantry/*` packages; add to root `workspaces`).
- **Move into it** the contents of `apps/core/src/adapters/storage/postgres/repositories/credential-secret-crypto.ts` — `encryptCredentialSecretValue`, `decryptCredentialSecretValue`, key resolution (`RuntimeSecretProvider`, `EnvRuntimeSecretProvider`, `resolveCredentialSecretKeyById`), the `gcred:v2` format constants, and `CredentialSecretCryptoIntegrityError` — **plus** the `modelCredentialAadContext({appId, providerId, authMode, schemaVersion})` AAD builder (the connector must build the identical AAD or decryption fails).
- **Update core's 3 importers** to import from `@gantry/credential-crypto`: `model-credential-repository.postgres.ts`, `capability-secret-repository.postgres.ts`, `control/server/routes/credentials.ts`. (If `modelCredentialAadContext` currently lives elsewhere, move/re-export it from the package too.)
- Behaviour is byte-identical — this is a move + re-point, no logic change. Existing core crypto unit tests move with it (or import from the package) and must stay green.

### 1b. Connector credential bootstrap

- **Create** `packages/mcp-crm/src/gantry-credentials.ts` exporting `bootstrapGantryCredentials(pool, { appId, log })`:
  1. `SELECT payload_encrypted, auth_mode, schema_version FROM <gantry>.model_credentials WHERE app_id=$1 AND provider_id='anthropic' AND status='active' LIMIT 1` (schema from existing env helper).
  2. `decryptCredentialSecretValue(payloadEncrypted, modelCredentialAadContext({appId, providerId:'anthropic', authMode, schemaVersion}), secrets)`. **Key sourcing:** the connector reads `~/gantry/.env` on demand (it does **not** load it into `process.env`), but the crypto's default `EnvRuntimeSecretProvider` reads `process.env`. So the bootstrap must resolve `SECRET_ENCRYPTION_KEY` (and `SECRET_ENCRYPTION_KEYRING_JSON`) via the connector's existing `~/gantry/.env` reader and supply them to the crypto — either set them on `process.env` before the call, or pass a `RuntimeSecretProvider` backed by those values. Do not assume they're already in the launch env.
  3. `JSON.parse` → `payload.oauthToken`; set `process.env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken`.
  4. No-ops (with a clear log) when: a raw `ANTHROPIC_API_KEY` is already set (it wins, like OneCLI did), no active row, or `SECRET_ENCRYPTION_KEY` missing — the extractor then self-disables exactly as it does today on broker-unreachable.
- **Swap** the call site in `packages/mcp-crm/src/index.ts`: `bootstrapOneCliCredentials(...)` → `bootstrapGantryCredentials(pool, …)`.
- **Simplify** `packages/mcp-crm/src/extractor/llm-client.ts` `SDK_ENV_KEYS` to drop proxy/CA (`HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`NODE_EXTRA_CA_CERTS`) — the real OAuth token reaches Anthropic directly (proven: core's agent works on it with no proxy). Keep `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` (fallback), `PATH`, `HOME`.

### 1c. Removals

- Delete `packages/mcp-crm/src/onecli-bootstrap.ts`.
- Remove `@onecli-sh/sdk` from `packages/mcp-crm/package.json`.
- Remove `ONECLI_*` reads from `packages/mcp-crm/src/env.ts` if now unused; document that `ONECLI_DATABASE_URL` can be removed from `~/gantry/.env` and the OneCLI broker is no longer required at runtime.

---

## Piece 2 — Event-driven CRM trigger (hybrid: event + backstop)

### 2a. Core emits `digest.session-end`

- **Add** `DIGEST_SESSION_END: 'digest.session-end'` to `apps/core/src/domain/events/runtime-event-types.ts`.
- **Thread an `onDigestSaved` callback** (optional) from `boundary-extraction-core.ts` — invoked right after `saveAgentSessionDigest()` succeeds (`:337`) with `{ appId, agentSessionId, conversationId, threadId, digestId, trigger }` — up through `app-memory-session-boundary-collector.ts` to `runtime-app.ts`, where `getRuntimeStorage().runtimeEvents.publish()` is in scope. Publish `{ eventType: DIGEST_SESSION_END, appId, conversationId, sessionId: agentSessionId, threadId, payload: { digestId, trigger } }`.
- Publishing is best-effort and **must not** fail or delay the boundary flow (wrap in try/catch + log). The digest row is already committed; the event is an optimization.
- Durably recorded via the existing `runtime_events` + `event_bus_outbox` write inside `publish()`.

### 2b. Connector LISTENs + keeps a backstop

- **Add** `packages/mcp-crm/src/watcher/digest-listener.ts`: a dedicated `pg` client doing `LISTEN gantry_runtime_events`, parsing the wakeup JSON, filtering `eventType === 'digest.session-end'` (and `appId === reconcileAgentId`'s app), and invoking a debounced `tick()`. Handle disconnect with reconnect + backoff (mirror core's notifier listen client).
- **Wire** it into `startDigestWatcher` (`watcher/index.ts`) alongside the existing interval.
- **Demote the timer to a backstop:** keep `setInterval(tick, …)` but default the interval to ~300 000 ms (5 min) — it now only sweeps up anything a missed/!listening NOTIFY dropped. The `boondi_digest_cursor` remains the source of truth, so the immediate-`tick()` and the backstop-`tick()` are both idempotent (a cycle already covered by the cursor finds nothing). A small in-flight guard prevents overlapping cycles when an event and the backstop coincide.

---

## Data flow (end to end, after both pieces)

1. Session goes idle (`idle_end_minutes`) → core idle sweep (30 s) ends it → **one LLM call** → facts + digest text → `saveAgentSessionDigest` (`:337`).
2. Core publishes `digest.session-end` (durable: `runtime_events` + `event_bus_outbox`; NOTIFY on `gantry_runtime_events`).
3. Connector's LISTEN fires → debounced `tick()` → `findNewDigests` (cursor) → **one LLM call** (connector) → upsert `boondi_business_records` + advance `boondi_digest_cursor`. Latency ≈ seconds.
4. If the connector was down/disconnected at step 2, the next 5-min backstop `tick()` finds the digest past the cursor and processes it. Nothing lost.
5. Credential for step 3's LLM call comes from `bootstrapGantryCredentials` (Credential Center), not OneCLI.

---

## Error handling

- **Credential bootstrap:** missing key/row/`SECRET_ENCRYPTION_KEY` → log + no-op (extractor self-disables, same as today's broker-unreachable). Malformed ciphertext → `CredentialSecretCryptoIntegrityError` surfaced in the boot log; the connector starts but extraction is disabled until fixed (never crash-loop).
- **Event publish:** wrapped try/catch; a publish failure logs and is swallowed — the digest is already durable and the backstop poll covers it.
- **LISTEN:** connection drop → reconnect with backoff; while disconnected, the backstop poll guarantees coverage. Malformed payload → log + ignore.
- **Idempotency:** all processing keys off `boondi_digest_cursor`; double-fire (event + backstop) is safe.

## Testing

- **Piece 1 (hermetic):** unit-test `gantry-credentials` decrypt against a known `gcred:v2` ciphertext encrypted with a test key (round-trip via the shared package, asserting the same AAD). Core crypto tests stay green after the move. **Live:** connector boots with OneCLI broker stopped, logs `gantry_creds_loaded`, and the existing e2e (lead conversation → `business_records`) still passes on the gateway token.
- **Piece 2 (hermetic):** unit-test the LISTEN consumer's filter (right `eventType`/`appId` → `tick`, others ignored) against synthetic NOTIFY payloads; unit-test that `onDigestSaved` is invoked after a digest save. **Live:** send a lead conversation, force idle, assert the connector processes within ~a few seconds of the digest (not the backstop interval); then kill the connector across a digest, restart, assert the backstop catches it.
- Follow repo conventions in `docs/QUALITY.md` / `WORKFLOW.md`; hermetic unit tests (mock `pg` pool + mock LLM) for CI.

## Phasing

- **Phase 1:** shared crypto package + connector credential bootstrap + OneCLI removal. Independently landable and testable; retires OneCLI on its own.
- **Phase 2:** digest event emit + connector LISTEN + backstop demotion. Independently landable; a pure latency/efficiency improvement.
- Phase 1 has the security-sensitive surface (crypto move, decryption parity) — land and verify it before Phase 2.

## Out of scope (YAGNI)

- No connector consumption of `event_bus_outbox` (the cursor backstop already guarantees durability for this single consumer).
- No change to core's idle-detection timer (idleness is the absence of events — inherently clock-driven).
- No new provider modes; OAuth (`claude_code_oauth`) only, with raw `ANTHROPIC_API_KEY` as the existing fallback.
