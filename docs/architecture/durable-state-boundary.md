# Durable State Boundary

MyClaw durable state has two categories.

Canonical runtime state lives in Postgres. This includes apps, agents,
conversations, threads, messages, sessions, provider session metadata, runs,
memory, jobs, permissions, tools, skills, browser profiles, and control events.

Provider artifacts are continuation or export artifacts stored behind
`ProviderArtifactStore`. Claude JSONL files are provider artifacts, not
canonical conversation records.

Claude runtime files are temporary materializations. `settings.json`, `skills/`,
and provider session files are generated inside a per-run `CLAUDE_CONFIG_DIR`
from canonical config, package skill assets, and provider artifacts.

## Allowed Durable Stores

- Postgres for canonical runtime state and artifact metadata
- Local filesystem artifact root for single-node provider artifact bytes
- Object storage for future multi-node provider artifact bytes

## Disallowed Durable State

Runtime code must not persist Claude/provider JSONL directly under the runtime
home Claude directory, `DATA_DIR/sessions`, or any ad hoc durable path. Claude
SDK files may exist only in a temporary run directory while the provider adapter
is executing.

Runtime code must also not treat runtime-home Claude settings, local settings,
or skills directories as enterprise source of truth. `settings.local.json` is a
Claude-local concept, not MyClaw policy.

Existing local JSONL files are not imported automatically. Operators can remove
old local session files after confirming no older runtime version needs them.
