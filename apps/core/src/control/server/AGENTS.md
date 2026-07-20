# Control Server

- Projection sync after app-scoped agent, skill, or MCP administration must
  export only conversation routes owned by that app. Never feed default-app
  routes or provider accounts into a non-default app settings revision.
- Non-default app projection sync must use that app's latest durable settings
  revision as its previous-state baseline; the shared local `settings.yaml`
  may represent a different app after startup or another control-plane write.
- Non-default app desired-state reconciliation must not overwrite the shared
  `settings.yaml` or activate that app's model aliases process-wide.

## Swagger And OpenAPI

- Keep OpenAPI documentation adapter-owned in this folder; do not make domain or application layers import documentation types.
- `/openapi.json` and `/docs` are read-only documentation surfaces. They must not expose secrets or runtime state.
- When adding, renaming, or removing control routes, update `openapi.ts` with the path, method, auth scopes, and a short behavior description in the same change.
- Document required control API scopes with the `x-gantry-required-scopes` extension so Swagger users can see which token grants are needed before trying a request.
- Model/default routes must stay provider-neutral. Inject provider credential
  preflight through `ControlRouteContext` instead of importing provider adapters
  or raw settings loaders directly from route modules.
- Model responses expose `responseFamily`, `modelRoute`, readiness, and
  capability descriptors. Keep raw provider model IDs under diagnostic
  `modelRoute.metadata`; do not reintroduce top-level provider slug fields.
- `/v1/credentials/models` must expose credential mode metadata and redacted
  status only. Writes accept `authMode` plus a provider-mode `payload`; PATCH
  rotates fields within the existing auth mode and must not change `authMode`.
  OpenAPI schemas/examples must never return secret payload values, service
  account JSON, cloud access keys, provider OAuth tokens, or secret-manager
  resolved values.
- Run-event projections may classify runtime diagnostics for operators, but
  they must not turn diagnostic payloads into authority, routing, or setup
  decisions. Keep secret/prompt redaction at the event producer or aggregator
  boundary before exposing details through control routes.
- Production or non-loopback TCP control startup must require strong keyed
  `GANTRY_CONTROL_API_KEYS_JSON` records. Do not add a remote auto-accept path;
  approval shortcuts are local-development-only and must fail closed remotely.
- `/v1/runtime-events` is a durable application integration stream. Always
  derive its app scope from the API key, preserve cursor replay, and never
  accept an app id from query input.
- An explicit session-message `model_alias` is a per-turn override. Persist it
  with the accepted message controls and resolve it before session/default
  aliases.
- Keep optional channel transport health on authenticated `/v1/health` as
  redacted, injected observability. Do not import provider adapters into control
  routes or make global `/readyz` depend on a channel being configured,
  connected, or holding an authenticated conversation registration.
