# Boondi CRM Prefetch Live Evidence

Date: 2026-06-20 IST
Runtime home: `/Users/caw-d/gantry`
Worktree: `/Users/caw-d/Desktop/gantry/.claude/worktrees/pillar-1-event-ipc-transport`

## Services

- Core, Shopify MCP, and CRM MCP were started in dev mode only.
- Core logs:
  - cold/default paths: `/tmp/boondi-prefetch-core-live.log`
  - warm-pool path: `/tmp/boondi-prefetch-core-warm-live.log`
- CRM watcher was run with `BOONDI_CRM_AGENT_ID=agent:disabled_for_prefetch_live` to avoid unrelated digest extraction calls.
- Services were stopped after testing.
- `runtime.warm_pool.enabled` was restored to `false` after the warm test.

## Local Test Setup Notes

- Added local DB provider connection row `interakt_default` because inbound message persistence used that id while the DB only had `channel-providerConnection:default:interakt`.
- Earlier failed setup attempts for `000777040001` are visible in the log; the passing no-digest turn is the second inbound at `2026-06-19 21:02:22.107+00`.

## Scenarios

| Scenario | Phone | Result |
| --- | --- | --- |
| No digest, cold path | `000777040001` | No CRM prefetch. Reply asked normal gifting qualification questions. |
| Digest + multiple CRM records | `000777040002` | One `get_last_query_or_lead` call returned latest record `bcr_live_000777040002_latest`; reply referenced birthday/sister/12/900/Bandra, not older wedding row. |
| Same conversation follow-up | `000777040002` | Second turn continued context. No second CRM prefetch for this phone; only Shopify lookup occurred. |
| Digest exists, no CRM record | `000777040003` | CRM prefetch returned `{"found":false}`. Reply stayed generic and asked for missing details. |
| CRM MCP unavailable | `000777040004` | Prefetch logged `boondi_crm_prefetch_failed { err: 'fetch failed' }`. Reply still persisted. |
| Existing normal provider session | `000777040005` | Fresh run used CRM context and wrote a new provider session id. This did not force stale-resume recovery. |
| Real stale provider session | `000777040007` | First run had `resumed:true`, SDK returned `No conversation found`, runtime expired stale provider session, retried `resumed:false`, then replied using CRM context. |
| Warm-pool bind | `000777040006` | Warm pool prewarmed, `Warm worker acquired; binding to conversation`, CRM prefetch returned compact record, reply referenced corporate/100/850/Bengaluru. |

## Key Log Anchors

- No-digest pass: `/tmp/boondi-prefetch-core-live.log`
  - `flow:llm.input` for `wa:000777040001`
  - no `get_last_query_or_lead` for `wa:000777040001`
- Latest CRM pass:
  - `flow:mcp.request` `serverName=boondi-crm`, `toolName=get_last_query_or_lead`, `chatJid=wa:000777040002`
  - response contains `bcr_live_000777040002_latest`
- No CRM record:
  - `wa:000777040003` response contains `{"found":false}`
- CRM down:
  - `boondi_crm_prefetch_failed { provider: 'returning-customer-crm', err: 'fetch failed' }`
- Stale provider session:
  - `wa:000777040007` first `flow:llm.input` has `resumed:true`
  - runner error: `No conversation found with session ID: 00000000-0000-4000-8000-000000040007`
  - runtime log: `expired stale provider session and retrying without resume`
  - second `flow:llm.input` has `resumed:false`
- Warm pool:
  - `/tmp/boondi-prefetch-core-warm-live.log`
  - `Provider cache prewarm succeeded`
  - `Warm pool prewarm ready`
  - `Warm worker acquired; binding to conversation`
  - `flow:mcp.response` for `wa:000777040006` contains `bcr_live_000777040006`

