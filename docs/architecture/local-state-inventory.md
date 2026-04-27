# Local State Inventory

This inventory classifies local filesystem state by durability.

## Durable Local State

- runtime home `settings.yaml`: non-secret runtime settings.
- `<runtime-home>/artifacts/provider-sessions/`: provider artifact bytes when
  using the `local-filesystem` artifact backend.
- Local credential files managed by their owning credential adapters.

## Temporary Local State

- Per-run Claude `CLAUDE_CONFIG_DIR` directories under the OS temp directory.
  These include generated `settings.json`, materialized `skills/`, and restored
  provider session files.
- IPC input/output files for active runtime processes.
- Build, test, coverage, and generated verification artifacts.

Temporary state may be deleted without losing canonical conversation history or
provider continuation artifacts.

## Legacy Local State

Older code may have left Claude JSONL under runtime-local `.claude` or
`data/sessions/<group>/.claude` paths. These paths are no longer the durable
source of truth. The provider artifact store is the supported continuation
boundary.

Older code may also have generated runtime-home Claude settings and skills.
Enterprise runtime no longer reads those paths as configuration or skill truth.

No automatic migration is provided for old local Claude files.
