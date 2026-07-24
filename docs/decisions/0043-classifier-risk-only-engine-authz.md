---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-23
---

# Classifier Risk Only, Engine Owns Authorization

## Context
The goal doc's fuller design had the classifier LLM return a two-factor verdict
(`risk_level` × `user_authorization`), the second factor guessed from the
transcript — the codex/Guardian shape, which exists only because Guardian is
stateless. Gantry's engine is NOT stateless: it deterministically holds the
authorization facts (a conversation grant exists, the requester is an admin, a
capability covers the action, a trusted root applies). Making the LLM also guess
authorization is redundant and hallucination-prone.

## Decision
The classifier returns `risk_level` (low/med/high/critical) + rationale ONLY. The
coordinator derives the outcome from that risk and the authorization it already
holds: low/med → allow; high → allow iff authorization is held, else ASK;
critical → ASK (or hard-deny by rail). Codex RISK calibration lines are imported
verbatim (risk scoring is kept); the authorization half of the two-factor schema
is dropped from the LLM.

## Consequences
Supersedes the two-factor LLM verdict described in the goal doc's fuller text
(the goal doc's "Leaner target" section already flags this). Authorization stays
a deterministic engine fact, not an LLM guess — simpler and more robust. The
classifier prompt + verdict schema + its cache store only `risk_level`.
