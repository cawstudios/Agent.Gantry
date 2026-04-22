# Memory System

MyClaw memory stores durable facts, decisions, preferences, corrections, constraints, and reusable procedures.

Continuity uses remembered context to help the next run continue work without replaying full chat history.

## Runtime Truth

- Host runtime only.
- `settings.yaml` is the canonical runtime behavior config.
- `.env` is for secrets and channel credentials.

## Canonical Settings

Runtime storage + memory behavior are configured in `~/myclaw/settings.yaml`:

```yaml
storage:
  provider: sqlite
  sqlite:
    path: store/myclaw.db

memory:
  enabled: true
  root: memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
```

## Storage

- Runtime storage backend in host runtime is `sqlite`.
- Memory SQLite database path is derived from `memory.root`: `~/myclaw/memory/.cache/memory.db` by default.
- `memory.root` resolves under the runtime home unless it is absolute.
- Journal path is `~/myclaw/memory/.journal`.

## Embeddings

- Optional.
- Disabled by default.
- Memory save/search/injection works when embeddings are disabled.
- `openai` requires `OPENAI_API_KEY` in `.env`.

## Dreaming

- Optional background memory refinement.
- Disabled by default.
- Should be used only with persistent memory enabled.
- When enabled, dream lifecycle metadata (enabled state, schedule, last outcome) is included in the injected continuity brief.

## Injection Model

- Host runtime injects memory/continuity context for every agent run (message turns and scheduler jobs).
- Injection does not rely on the agent deciding to call `memory_search` first.
- Memory tools remain available for deeper retrieval, explicit saves, and patch operations.

## Scope Defaults

- `user`: personal preferences/corrections for one user.
- `group`: active channel/chat memory (default).
- `global`: cross-chat memory; use only with explicit user intent.
- If a `thread_id` exists, treat it as a topic boundary and include topic markers in memory keys.

## User Controls

- `myclaw status`
- `myclaw doctor`
- `myclaw memory status`
- `myclaw memory embeddings <off|openai>`
- `myclaw memory dreaming <on|off>`

## Direct Editing Flow

1. Edit `~/myclaw/settings.yaml`.
2. Run `myclaw doctor`.
3. Restart (`myclaw restart` or `myclaw service restart`).
4. Confirm with `myclaw status`.