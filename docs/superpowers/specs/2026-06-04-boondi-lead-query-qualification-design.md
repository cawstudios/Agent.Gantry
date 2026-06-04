# Boondi Lead/Query Qualification — Refine, Verify & Prove via an Autonomous Runtime Loop

**Date:** 2026-06-04
**Branch:** `feat/interakt-shopify`
**Owner:** Claude (acting as the architect of Boondi)
**Status:** Approved design (with revisions) — proceeding to plan + execution autonomously.

---

## Operating Mandate (non-negotiable — governs this entire run)

These directives, given by the product owner, outrank convenience and override any
default urge to stop early or seek reassurance. They apply to every phase below.

1. **I am the architect of Boondi. I own it completely.** Every decision, every
   line, every tradeoff is mine to make and defend.
2. **I work fully autonomously.** No hand-holding, no waiting for permission. I
   drive the work end to end.
3. **I never bounce decisions back.** When I hit multiple options or feel
   uncertain, I do not ask — I investigate. I evaluate every option myself and
   choose what is genuinely best from a product and customer standpoint.
   Indecision is not an output.
4. **I assume nothing, ever.** Code is the only source of truth. If I don't know,
   I read the code until I do. Guesses are forbidden.
5. **I take no shortcuts.** If the right fix is a big, hard change, I make the
   big, hard change. Patch-jobs and band-aids are not acceptable when the problem
   demands real surgery.
6. **I use the superpowers skills wherever they apply** (TDD, systematic-debugging,
   writing-plans, executing-plans, verification-before-completion, etc.). Default
   to leveraging them.
7. **I stop for exactly one reason: the task is 100% done.** Nothing less ends the
   run. Partial completion is not completion.
8. **I use the best available model to implement (Claude Opus 4.8)** — for my own
   work and for any subagents I dispatch on non-trivial reasoning.

> Note on Boondi's *runtime* model: the production `boondi_support` agent runs on
> `sonnet` with thinking disabled (latency choice). That is separate from rule 8
> (which governs *my implementation* work). Whether to raise Boondi's runtime
> model is a product tradeoff I own and will decide from loop evidence (see §9),
> not an assumption made up front.

---

## 1. Context & current state (verified against code, not assumed)

Boondi is the Bombay Sweet Shop WhatsApp concierge on Gantry. Flow:
Interakt webhook → agent guardrail → agent (model `sonnet`, thinking disabled) →
Shopify MCP (`:8081`, read-only store data) and/or boondi-crm MCP (`:8082`,
lead/query capture). A separate read-only Next.js dashboard at
`~/Desktop/boondi-admin` renders the result.

**What already exists (confirmed):**

- **Agent prompt content** (uncommitted on this branch): `SOUL.md` §9 "Query vs
  lead"; `CLAUDE.md` "Capturing business interest — silently" (maps conversation
  → the 4 boondi-crm tools + exact fields/enums) and "Greeting a returning
  customer personally"; `boondi-kb/SKILL.md` "Gifting & business-interest cues" +
  the five qualification questions; guardrail lets returning-customer greetings
  through.
- **CRM connector** `packages/mcp-crm` (port 8082): table `boondi_business_records`
  with status ladder `query → qualifying → lead → handed_off/won/lost`,
  `intent_category`, the five gifting fields + scoring inputs; 4 tools
  (`record_query`, `upgrade_to_lead`, `update_record`, `get_open_records`);
  deterministic 7-dimension scoring (A quantity 25, B budget 20, C buyer 15,
  D customisation 15, E delivery 10, F timeline 10, G contact 5) → bands P1–P5;
  durable heuristic reconciler backstop; identity via signed `X-Caller-Identity`.
- **Wiring (confirmed in `~/gantry/settings.yaml` + `~/gantry/.env`):**
  `mcp:boondi-crm` is registered (HTTP `:8082`, caller-identity required,
  `signing_ref: SHOPIFY_MCP_IDENTITY_SECRET`, tool patterns
  `record_*/upgrade_*/update_*/get_*`, `credential_refs: BOONDI_CRM_DATABASE_URL`),
  and the `boondi_support` agent attaches **both** `mcp:shopify-api` and
  `mcp:boondi-crm`. The `.env` has `BOONDI_CRM_MCP_PORT / DATABASE_URL / DB_SCHEMA`.
  **Key fact:** `caller_identity.source = conversation_jid_phone` → by default the
  CRM record's phone equals the sender's phone, so a chat and its lead/query line
  up by phone with no extra work. The single-test-number override is a
  Shopify-only test convenience.
- **Dashboard** `~/Desktop/boondi-admin`: chat view shows **both** sides
  (`direction` inbound/outbound), a Leads board with **Leads** and **Queries**
  tabs (split by status), and a per-chat **Memory panel** (open record + memory),
  joining record↔chat by phone. Reads `gantry` Postgres read-only, polls 10s.
- **Test harness** `scripts/interakt-test-*`: `interakt-test-send.mjs` signs an
  Interakt webhook (mimics a customer); `interakt-test-run.mjs` drives multi-turn
  scenarios in the **real runtime**, parses `GANTRY_FLOW_LOG` lines, and asserts
  guardrail/MCP/reply/language/output-discipline across parallel lanes.

**The gap this work closes:** the harness has **zero** lead/query coverage — it
never asserts a boondi-crm capture fired, never checks a row persisted, never
verifies dashboard visibility. There is no behavioral refinement loop. And the
qualification ask currently says "one at a time," which the owner has changed.

---

## 2. Goals / Non-goals / Constraint

**Goals**

1. Boondi reliably distinguishes **query** vs **lead** and captures even the
   *slightest forward-looking interest* as a query.
2. Boondi asks the five qualification questions **all in one message, as a clean
   list of points** — warm, scannable, conversion-oriented (see §4).
3. Every query/lead and **both sides** of each chat are visible and **lined up**
   in the dashboard.
4. An autonomous **mechanical + qualitative** test→fix loop *proves* the above in
   the real runtime, fixing in a loop until correct.
5. Leave the dashboard **running + populated** and a **per-scenario report** so
   the owner can inspect the real conversations and the admin panel directly.

**Non-goals (strong preference, not a hard line)**

- **No Gantry-core changes** — hard line, the separation rule.
- **Prefer not to touch** `packages/mcp-crm` or `~/Desktop/boondi-admin`. I will
  change them only if I judge it genuinely required to meet a goal, and I will say
  so and justify it (rule 1). Refine + surgical gap-fix, never rebuild.

**Constraint:** clean Boondi/Gantry separation everywhere. Boondi's behavior lives
in the agent folder + the connector; Gantry core provides only generic mechanism.

---

## 3. Primary lever: agent-behavior refinements (prompts)

Capture is LLM-driven, so prompt clarity is the main lever. Targets (tuned
iteratively from loop evidence — §6):

- **Capture boundary, made crisp.** A *query* = forward-looking interest in a
  **new** purchase / gift / bulk plan, at any size. **Not** past-order support,
  tracking, complaints, or refunds — those are support, not buying signals.
  This kills both under-capture (a soft "do you do hampers?" missed) and
  over-capture ("where's my order?" wrongly logged).
- **Query→lead trigger.** `record_query` on first genuine interest;
  `upgrade_to_lead` only on decided/strong intent or a strong-B2B signal
  (25+ pieces / total > ~₹10k / corporate email / multi-city / timeline < 1 week).
  No premature jump on a vague "maybe Diwali."
- **Invisible capture.** No narration; the customer-facing reply reads as if no
  capture exists. (Already specified; verified under test.)
- **Correct enum/field mapping.** `intentCategory`, `buyerType`, `locationScope`,
  `customisation`, contact fields filled with valid tokens; fix examples on drift.

Most of this is already written; the loop shows what needs sharpening.

---

## 4. The qualification ask — REVISED (owner directive)

**Change:** the five questions are asked **all at once, in a single message,
formatted as points** — not drip-fed one per turn, and never crammed into a dense
paragraph. This supersedes the existing "ask one at a time, never a form" wording
in `SOUL.md` §6/§9, `CLAUDE.md`, and `boondi-kb/SKILL.md`.

**Exact intended behavior:**

- When a gifting/B2B opportunity needs qualifying, Boondi sends **one** message: a
  warm one-line opener, then a short **numbered list** of the details still needed,
  then an easy, low-pressure close.
- **Ask only the gaps.** Details already shared (e.g. occasion) are omitted from
  the list — never re-ask what's known.
- The five fields: **Occasion · Quantity · Budget (per gift or total) · Delivery
  location(s) · Timeline**, plus branding/customisation when relevant.
- WhatsApp-formatted per `CLAUDE.md` rules: numbered lines, no markdown tables, one
  ask per line so it's trivial to scan and answer in one go.
- It is a **warm checklist, not a cold form** — keep the opener/close human; the
  list is the body. Register adjusts (crisp for corporate, softer for personal),
  but the *format* — questions together, as points — is constant.
- As answers arrive (in one message or several), Boondi captures each via
  `update_record`; if some are missing, it gently re-lists *only* the remaining
  points.

**Why this is the right call (architect's defense):** a clean, scannable list the
customer answers in one message means fewer turns, less friction, lower drop-off,
and a faster path to a quote — strictly better for conversion than an
interrogation, and ideal for the corporate buyer assembling an approval email. It
stays warm via framing, so it does not read as a bureaucratic form.

**Example (occasion already known, so omitted):**

> Ooh, Diwali gifting for your team — lovely! 😊 To pull together the best
> options, could you tell me:
> 1. How many gifts?
> 2. Rough budget per gift (a range is fine)?
> 3. Where they're headed — one city or a few?
> 4. When you need them by?
> 5. Any logo or branding on the boxes?
>
> Even rough answers help — I'll take it from there.

---

## 5. Verify (don't rebuild): connector, dashboard, identity

Confirm by reading code/state, fix only if genuinely broken (per §2):

- boondi-crm process **running** on `:8082`; migration applied so
  `boondi_business_records` exists in the **gantry** schema the dashboard reads.
- Connector `BOONDI_CRM_DATABASE_URL` / `BOONDI_CRM_DB_SCHEMA` resolve to the
  **same** DB + schema the dashboard reads (`gantry`). If they diverge, records
  won't surface — fix the config.
- **Outbound replies persist to `gantry.messages` even under
  `GANTRY_OUTBOUND_DRYRUN=1`** — required for the dashboard to show both sides.
  If dry-run suppresses persistence, that's a Boondi-side gap to fix (the test
  path must still record what the customer would have received).
- Dashboard Queries tab shows `query/qualifying`; Leads tab shows `lead/...`;
  Memory panel joins record↔chat by phone (lines up when identity = sender).

**Phone/identity strategy.** Capture/inspection scenarios run **without** the
Shopify single-number override → identity = each lane's own number → chat + record
+ memory all line up per conversation. Use a small pool of **dedicated persona
phone numbers**, one per scenario, so each scenario is its own clean conversation
in the dashboard. All lanes stay in the dry-run/operator set (never really sends).
The one or two scenarios that need real Shopify order history (returning customer)
may use the existing override on a separate lane.

---

## 6. Scenario matrix ("real scenarios," personas from SOUL §5)

Each scenario is a multi-turn conversation with **mechanical** expectations
(capture tool/status/intent/fields, or `crmNone`) and **qualitative** expectations
(tone, conversion, the points-style qualification ask, correct classification).

| # | Persona / flow | Expected capture | Key qualitative check |
|---|---|---|---|
| 1 | Soft shopping query ("what's good & sweet?") | `record_query` intent=shopping | slightest interest still captured; warm, 3 picks, no pressure |
| 2 | Personal gifter, ~1 box for a friend | query, gifting_personal | nudge to website **and** still capture |
| 3 | Occasion gifter — wedding, ~150 boxes | query→qualifying→**lead**, buyer=wedding_event | the **five Qs asked as one point-list** |
| 4 | Corporate employee gifting — 300 staff, corporate email | fast **lead**, corporate/employee_gifting, high band | recognise strong-B2B; fast route + brief |
| 5 | B2B multi-city — clients Mumbai+Delhi, logo | **lead**, locationScope=multi_city, customisation=logo | correct enum mapping; convert |
| 6 | Curious browser ("just checking, a friend mentioned you") | soft query | zero pressure, door open |
| 7 | Returning recognition — greeting w/ open lead | `get_open_records` fires | personal welcome, continue the thread |
| 8 | **Neg control** — pure order support ("where's my order") | **crmNone** | answers support; no capture |
| 9 | **Neg control** — complaint + refund | **crmNone** | empathy first, human handoff, no false promise |
| 10 | **Neg control** — out-of-scope (weather) | **crmNone** | guardrail rejects |
| 11 | Progressive qualification — budget/timeline revealed later | `update_record` adds fields, score recomputes | re-list only the gaps; capture each answer |
| 12 | Reconciler backstop — idle convo w/ clear signal, agent path off | reconciler reconstructs a **query** | tested separately (reconciler on) |

I own this matrix and will extend/adjust it as the loop reveals gaps.

---

## 7. Harness extensions (the deterministic net) — built TDD-first

- New `scripts/interakt-test-scenarios-capture.json` — separate from the Shopify
  matrix (keeps each suite single-purpose).
- New `expect` fields in `interakt-test-run.mjs`:
  - `crm: { tool, status, intentCategory, fieldsPresent: [...], expectScored | band }`
    — verified from the flow-log `mcp.request` to `serverName: boondi-crm`
    (toolName + arguments) for that turn.
  - `crmNone: true` — assert **no** boondi-crm capture happened this turn
    (negative controls 8–10).
- New `scripts/verify-capture.mjs` — after each scenario: read
  `boondi_business_records` by phone from Postgres **and** GET the dashboard's own
  API routes (`/api/records`, `/api/messages?conversationId=`, `/api/memory?phone=`)
  to prove the read path surfaces the record + both chat sides. Emits a structured
  per-scenario report (transcript + record + verdict).
- Run plumbing: a **self-identity mode** (no Shopify override on capture lanes), a
  **DB reset** step clearing test-phone rows + conversations between full runs, and
  the **reconciler disabled** during the agent-path loop (re-enabled only for
  scenario 12).

Assertions are written **before** the behavior is judged green (TDD): the new
`crm`/`crmNone` checks and the verifier define "correct," then the loop drives
Boondi to satisfy them.

---

## 8. The autonomous test→fix loop

**Preflight (every run):** strip `ANTHROPIC_*` env; ensure a single runtime on
`:4710`; start Shopify MCP (`:8081`), boondi-crm (`:8082`), and the dashboard;
apply the migration; set flags `GANTRY_FLOW_LOG=1 GANTRY_OUTBOUND_DRYRUN=1`,
capture lanes in the operator set, **no** identity override on capture lanes,
reconciler off; reset test rows. Confirm `:8082` is actually up (owner directive d).

**Loop (bounded, ≈≤6 rounds, stop on no-progress, else continue to green):**

1. Run the capture suite across parallel lanes.
2. Collect mechanical failures + full transcripts + DB records.
3. **Qualitative review** per scenario: warmth, conversion, the points-style
   qualification ask, correct query-vs-lead, invisible capture, correct fields.
4. Diagnose root cause (systematic-debugging) → prompt vs. mapping vs. code.
5. Fix the prompt (`SOUL/CLAUDE/KB`) or, only if required, code.
6. **Apply runtime gotchas (from code/ops reality, not assumed):** prompt edits
   sync into the profile at **boot only → restart Gantry**; boondi-crm code →
   **rebuild + restart** the connector; agent-runner-side changes → **`npm run
   build`** (runner execs from `dist/`). One runtime at a time.
7. Re-run. **Exit only when all mechanical pass AND qualitative is satisfied.**

Then run scenario 12 with the reconciler **enabled** and confirm it reconstructs a
query from the durable transcript.

---

## 9. Decisions I own (no bouncing back)

- **Boondi runtime model/thinking.** If sonnet+thinking-off under-captures even
  with sharp prompts, I weigh latency vs. capture accuracy and decide (e.g. raise
  to a stronger model or enable adaptive thinking for qualification turns). The
  reconciler backstops correctness regardless. Decided from loop evidence.
- **Connector/dashboard edits.** Default off; I make a surgical change if a goal
  is otherwise unreachable, and I justify it.
- **Scenario matrix scope.** Mine to extend.

---

## 10. Inspection deliverable (what the owner gets)

- Dashboard **running + populated**: each persona its own conversation (both
  sides) with its lead/query lined up (Leads/Queries tabs + Memory panel).
- A written **per-scenario report**: persona, full transcript (customer + Boondi),
  resulting record (status/intent/fields/score/band), mechanical verdict, my
  qualitative verdict, and where to see it in the dashboard.
- Committed harness additions = a permanent regression net.

The owner then inspects the real conversations + the admin panel directly.

---

## 11. Risks / verify-early

- boondi-crm must be **running + migrated** (wired in config ✓; process/table
  existence confirmed in preflight).
- Connector-write DB/schema **==** dashboard-read DB/schema (both `gantry`;
  confirm the URLs resolve identically).
- **Dry-run must still persist outbound** to `gantry.messages` (confirm; fix on
  Boondi side if not — it blocks the both-sides goal).
- Identity-override gating is env-level (structurally confirmed:
  `source = conversation_jid_phone`; override is test-only) — no core change.
- **Reconciler could race/duplicate** during agent-path testing → disabled during
  that phase, tested on its own (scenario 12).
- **sonnet + thinking-off may under-capture** → sharpen prompt; reconciler
  backstops; escalate model only if evidence demands (§9).
- **Re-run cleanliness** → DB reset of test phones between full runs.

---

## 12. Definition of done (rule 7)

All true, verified with evidence (verification-before-completion):

1. Every capture scenario passes its **mechanical** assertions (right tool/status/
   intent/fields; negative controls capture nothing).
2. Every scenario passes my **qualitative** bar (warmth, conversion, points-style
   qualification ask, correct classification, invisible capture).
3. Each record + both chat sides are **visible and lined up** via the dashboard's
   own read path.
4. The reconciler backstop reconstructs a query (scenario 12).
5. Dashboard left running + populated; per-scenario report written; harness
   additions committed.

Nothing less ends the run.
