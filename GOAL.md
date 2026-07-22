# Goal: Observer Stage 2 — insight emission + deterministic floor + semantic dedup

Branch `feature/observer-s2-emission` off main (Stage 1 foundations are MERGED: the
`proactive_insights` table, `observer-insight-repository.postgres.ts`, the
`observer_insight_cursors`, and `observer.owner.*` all exist on main — read them). Full design:
`proactive-observer-plan.md` (read the L2 section). Behind flag `observer.enabled` (default off).
NO batch transport (Stage 3), NO digest sending (Stage 4) — emit + persist insights only.

Postgres UP at `postgresql://postgres:postgres@127.0.0.1:5433/gantry_test` (env
`GANTRY_TEST_DATABASE_URL`).

## Build
1. **Extend the brain-dream proposer** (`brain/brain-dreaming.ts` + its proposer) to ALSO return
   `surfaceableInsights[]` for each page — types: commitment, contradiction, open_question,
   stale_fact, decision_without_owner, duplicated_work. Repetition insights keep coming from the
   existing `detectPatternCandidates` (`app-memory-dreaming.ts:280`) — normalize both into the
   `proactive_insights` shape. Use the EXISTING per-page LLM call (live path) — do NOT add batch
   (Stage 3 swaps the transport later). Keep the change flag-gated so proposer behavior is
   unchanged when observer is off.
2. **Deterministic value floor** (in code, model on `shared/pattern-candidate-policy.ts`):
   novelty (not already surfaced), confidence ≥ threshold, evidence-count ≥ threshold,
   not-a-duplicate-of-an-active-memory. Only survivors persist. NO per-message LLM anywhere.
3. **Semantic dedup** against the already-surfaced set: compute `canonical_signature` + populate
   `signature_embedding_ref` (reuse the memory embeddings infra); reject an insight whose
   signature embedding is within a similarity threshold of an active insight. This is what stops
   paraphrased nightly repeats. The partial-unique index on (app_id, canonical_signature) already
   enforces exact-signature dedup — add the SEMANTIC layer on top.
4. **Persist** survivors via the S1 `observerInsights` repo, advancing the SEPARATE
   `observer_insight_cursors` (NOT the brain dream cursor). State starts `pending`.
5. **API + SDK + E2E** (user mandate): extend `/v1/observer/insights` with type/state filtering +
   matching SDK; an E2E that drives emission → floor → persist and asserts the surfaced set.

## Hard rules
- Behind `observer.enabled` (default false). Proposer/dream behavior UNCHANGED when off.
- Do NOT break existing suites — after your change, run the FULL control + brain + memory unit
  suites, not just your new tests (Stage 1 shipped a regression that only the full suite caught).
- Behavioral assertions; reuse existing seams + harness. Ponytail-minimum.
- If you touch shared code (proposer output shape), grep all callers first + flag loudly.

## Verify (real DB)
1. `cd apps/core && npx tsc --noEmit` clean.
2. pg integration: emission → floor → dedup → persist (real rows, cursor advance). Paste counts.
3. FULL control + brain + memory unit suites green (`npx vitest run apps/core/test/unit/control
   apps/core/test/unit/brain apps/core/test/unit/memory`). Observer suites green.
4. E2E round-trip. Lint changed files.
5. Run `autoreview --mode local` (xhigh) and fix accepted findings BEFORE the commit.

## Output
COMMIT on `feature/observer-s2-emission` (NO Claude-Session trailer/URL). No PR/merge/other
branches. If sandbox blocks commit, leave staged + say so. Final message: what shipped (files +
insight types + floor thresholds + dedup mechanism), REAL full-suite pass counts, autoreview
result, anything deferred.

## Stage 2 contract decisions (orchestrator answers to the DECISION NEEDED — these are FINAL, proceed)

1. **Numeric floors** — put in a new tunable policy module (mirror `shared/pattern-candidate-policy.ts`):
   - `min confidence = 0.6` (per-insight LLM-reported confidence).
   - `min evidence count = 1` (a single clear source statement is a valid insight; confidence +
     novelty + semantic dedup do the filtering — do NOT drop single-source commitments/decisions).
   - `semantic dedup cosine >= 0.86`: reject a new insight if its `signature_embedding_ref` cosine
     similarity to ANY ACTIVE insight (state ∈ pending/claimed/sent/cooldown) for the SAME subject
     is ≥ 0.86. (Exact-signature dedup is already enforced by the partial-unique index.)
   - Repetition insights keep the existing 4-occurrences / 2-day floor from pattern-candidate-policy.
   Expose all three as named constants (tunable later); no settings key needed this stage.

2. **Subject mapping** — insight `subject` = the brain page's SOURCE conversation/channel key.
   The channel-harvest writes pages per account+conversation+thread/day, so the source conversation
   is recoverable from the page identity/metadata — use it (reuse the memory/brain subject resolver
   shape). Emit ONE insight per `(subject, canonical_signature)` — NOT once per bound agent (the
   digest goes to the app owner, not per-agent; avoid co-resident duplication). If a page's source
   conversation cannot be resolved, fall back to an app-scoped subject constant `observer:app`.

3. **Evidence refs** — `evidence_refs` stores STRUCTURED references, NOT literal URLs:
   `[{ conversationId, messageId, ts }]` (messageId may be a transcript/message id). Permalink
   RENDERING (the one-click-verify URL) is DEFERRED to Stage 4 (digest delivery knows the channel
   provider and builds the platform permalink). For repetition/pattern candidates, map their
   transcript IDs into this shape (conversationId from the candidate subject, transcriptId → messageId).

Proceed with implementation using these. Do NOT re-raise these three.

## Stage 2 clarifications round 2 (orchestrator answers — FINAL, proceed, do NOT re-raise)

1. **Embeddings unavailable** → CONFIRMED: persist NOTHING and do NOT advance the observer cursor
   this run (so pages are re-processed once embeddings return; semantic dedup is required, so we do
   not persist without it). ADDITION: surface this via the honest off-state — "insight emission
   paused: embeddings unavailable" — so it is not silently stuck. Do not fall back to exact-only.
2. **Active-memory dedup** → CONFIRMED: the "not-already-an-active-memory" floor uses an EXACT
   canonicalized match scoped to the SAME source conversation. The `0.86` cosine threshold is
   EXCLUSIVE to active-insight-vs-new-insight dedup (not used for the memory check).

These are the final clarifications. Proceed to full implementation, verify, autoreview, and commit.
