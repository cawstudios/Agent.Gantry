# 2026-04-17 — Settings And Runtime Truth

## Context

MyClaw must present one runtime truth across runtime code, CLI, diagnostics, setup, docs, and shipped skills. Runtime behavior settings were previously split between `settings.yaml` and `.env`, which created conflicting states and unclear operator UX.

## Decision

1. Runtime mode is fixed to host runtime only.
2. `settings.yaml` is the canonical runtime behavior surface for non-secret settings.
3. `.env` is for secrets and channel credentials only.
4. Memory runtime behavior is controlled only by `settings.yaml`:
   - `memory.enabled`
   - `memory.embeddings.enabled`
   - `memory.embeddings.provider` (`disabled`, built-in provider ids, or registered provider ids)
   - `memory.embeddings.model`
   - `memory.dreaming.enabled`
5. `settings.yaml` runtime behavior schema is `channels.*`, `storage.*`, `credential_broker.*`, and `memory.*`.
6. `credential_broker.onecli.postgres.*` declares the OneCLI persistence contract. It stores only the env key and schema name; the URL and encryption key stay in `.env`.
7. Continuity currently means injected remembered context plus memory tooling; commitment/inbox/digest controls are separate future work.

## Consequences

- CLI mutation commands update `settings.yaml`.
- `myclaw status` and `myclaw doctor` report memory/storage/embeddings/dreaming state from `settings.yaml`.
- Unsupported runtime and memory env keys are surfaced as warnings in doctor/config surfaces.
- Direct YAML edits remain first-class with strict validation and actionable path-level errors.

## Notes

- Runtime storage is Postgres via `MYCLAW_DATABASE_URL`.
- Memory data is stored in Postgres.
- Session transcript archives are operational artifacts under runtime `data/`,
  not the memory store.
- Embeddings are optional and disabled by default.
- Dreaming is optional and disabled by default.
