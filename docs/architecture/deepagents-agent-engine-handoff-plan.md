# DeepAgents Agent Engine Handoff Plan

Status: ENG-124 handoff plan, updated 2026-06-12 after the product decision that
users must be able to choose between Anthropic SDK and DeepAgents.

## Summary

Product model: an agent has a durable user-selected `agent_engine`, and each run
has a user-selected `modelAlias`; the model provider route determines whether
the endpoint family is `anthropic` or `openai`, and Gantry resolves
`agent_engine + modelAlias` to an internal execution adapter.

Gantry is not ready to enable DeepAgents as a runnable user-selectable engine
yet. The repo has the right seams (`AgentExecutionAdapter`, run leases,
provider-session metadata, memory IPC, model gateway env separation, sandbox
projection, and Gantry-owned tools), but the missing pieces are load-bearing:

- no `deepagents:langchain` adapter or dependency wiring exists;
- OpenAI is present as a provider definition but is not executable for chat;
- model catalog entries currently resolve to one `executionProviderId`;
- memory LLM routing is provider-neutral as a port but Anthropic as the default
  implementation;
- raw DeepAgents filesystem/shell/backend authority is not mapped to Gantry
  permissions;
- there is no acceptance test proving engine/model/provider compatibility,
  jobs, memory, sandbox, permissions, MCP, browser, and audit together.

Official docs to re-check before implementation:

- DeepAgents overview, tools, backends, sandboxes, permissions, memory, MCP, and
  human-in-the-loop: `https://docs.langchain.com/oss/javascript/deepagents/`
- LangChain JS OpenAI and Anthropic chat model integrations:
  `https://docs.langchain.com/oss/javascript/integrations/chat/openai` and
  `https://docs.langchain.com/oss/javascript/integrations/chat/anthropic`
- Claude Agent SDK TypeScript:
  `https://code.claude.com/docs/en/agent-sdk/typescript`

## Exact UX Contract

Durable user choice:

```yaml
defaults:
  name: Default Agent
  model: opus
  agent_engine: anthropic_sdk

agents:
  main_agent:
    name: Default Agent
    model: opus
    agent_engine: deepagents
```

Rules:

- `defaults.agent_engine` is the setup/default engine for agents that do not set
  their own engine.
- `agents.<id>.agent_engine` is the per-agent override.
- Valid values are `anthropic_sdk` and `deepagents`.
- Display labels are `Anthropic SDK` and `DeepAgents`.
- Conversations and jobs inherit the bound agent's engine.
- Conversation model overrides and job model defaults may still choose
  `modelAlias`; they must not choose engine.
- Public APIs must not accept `job.harness`, job-level `executionProviderId`, raw
  provider model ids, DeepAgents backend ids, Claude settings paths, or
  provider-native tool names.

Required CLI/API copy:

- Success: `Agent engine updated: main_agent now uses DeepAgents. Existing jobs and conversations use this engine on their next run.`
- Unsupported engine: `Unsupported agent engine: <value>. Choose anthropic_sdk or deepagents.`
- Unsupported model/engine pair: `Model <alias> cannot run with <engine>. Choose one of: <compatible aliases>.`
- OpenAI with Anthropic SDK: `Model <alias> uses the OpenAI endpoint, which is not supported by Anthropic SDK. Choose DeepAgents or an Anthropic-compatible model.`
- Claude OAuth with DeepAgents: `DeepAgents does not support Claude OAuth/subscription credentials in Gantry. Choose Anthropic SDK or configure Anthropic API-key Model Access.`
- Missing credential: `Setup required: configure <provider> Model Access before using <alias> with <engine>.`
- Unsafe sandbox: `DeepAgents requires an enforcing sandbox before shell or filesystem tools can be enabled in this deployment mode.`
- Raw execute blocked: `DeepAgents shell execution is disabled until Gantry can route it through RunCommand policy.`

Where users see the result:

- `gantry agent list` and `gantry agent show <id>` show `Agent engine`.
- `gantry model why <alias> --agent <id>` shows model alias, endpoint family,
  credential profile, agent engine, and diagnostic `executionProviderId`.
- Control API agent detail and SDK agent records expose `agentEngine`.
- Job run detail and runtime events show inherited `agentEngine` plus diagnostic
  `executionProviderId`.

## Implementation Changes

Capability-driven task decomposition:

1. Engine selection capability
   - Add public type `AgentEngine = 'anthropic_sdk' | 'deepagents'`.
   - Parse, render, validate, import, export, and project
     `defaults.agent_engine` and `agents.<id>.agent_engine`.
   - Add Control API, SDK, CLI, and Gantry admin tool support for reviewed engine
     updates.
   - Keep raw `executionProviderId` read-only and diagnostic.

2. Model route compatibility capability
   - Change model resolution from `modelAlias -> executionProviderId` to
     `modelAlias + agentEngine -> executionRoute`.
   - Each execution route declares endpoint family, model provider route,
     credential mode, supported workloads, and internal `executionProviderId`.
   - Enable OpenAI chat only for routes that are actually backed by a registered
     adapter.
   - Reject invalid combinations before runner spawn; do not fall back to a
     different engine.

3. DeepAgents execution capability
   - Add `deepagents:langchain` as an `AgentExecutionAdapter`.
   - Add a real runner under an adapter-owned directory; do not add placeholder
     files or shared runtime imports of DeepAgents/LangChain types.
   - Project model credentials only through Gantry loopback gateway env:
     `OPENAI_BASE_URL`/`OPENAI_API_KEY` for OpenAI endpoint routes and
     `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` for Anthropic endpoint routes.
   - Preserve existing runner output contracts for text, tool events, usage,
     provider-session metadata, terminal status, and errors.

4. Gantry authority bridge capability
   - Extract or reuse provider-neutral projection for Gantry facade tools,
     selected skills, selected MCP servers, canonical Browser, permissions,
     and audit.
   - Disable DeepAgents durable memory, raw `.mcp.json` authority, raw
     `LocalShellBackend`, raw `execute`, and raw filesystem permissions in v1
     unless they are explicitly routed through Gantry policy.
   - DeepAgents human-in-the-loop interrupts must create durable
     `pending_interactions` before provider-visible rendering.

5. Memory and continuity capability
   - Keep Gantry memory authoritative; DeepAgents memory is not durable state.
   - Inject `<gantry_memory_context trust="untrusted_data_only">` as prompt
     context, not system authority.
   - Add a route-aware `MemoryLlmClient` so extraction, dreaming, and
     consolidation can use OpenAI or Anthropic gateway routes without depending
     on the Anthropic adapter implementation.
   - Preserve `AgentSession` as canonical continuity; `ProviderSession` remains
     adapter metadata for live resume only.

6. Jobs, live turns, sandbox, and audit capability
   - Jobs inherit the agent engine; no job-level engine override in v1.
   - Scheduler execution must still claim the run lease before runner spawn and
     fence terminal writes.
   - Live turns must still use durable owner routing for continuations, stops,
     stdin close, and interaction resolution.
   - Production/remote/org DeepAgents runs that enable shell or filesystem
     authority require an enforcing sandbox provider such as `sandbox_runtime`.
   - Audit every engine change and every resolved run with `modelAlias`, endpoint
     family, `agentEngine`, `executionProviderId`, credential mode without
     secrets, sandbox provider, permission decision, and egress decision.

7. Docs and cleanup capability
   - Update README, SDK docs, model catalog ADR, credential docs, sandbox docs,
     DeepAgents prompts, and AGENTS guidance.
   - Remove or revise stale "harness choice is alias-only/internal" language.
   - Do not add compatibility aliases, deprecated fields, local-only branches, or
     dead code.

Suggested parallel work packets after this handoff:

- Runtime/model worker: settings parser/render/projection, `AgentEngine` type,
  model resolver matrix, adapter registry selection.
- Adapter worker: DeepAgents adapter and runner, gateway env projection, runner
  frame normalization.
- Authority worker: shared tool/MCP/skill/browser/permission projection and raw
  DeepAgents authority denial.
- Memory/session worker: route-aware `MemoryLlmClient`, memory context
  injection, provider-session semantics, stale-session retry.
- Jobs/live worker: scheduler inheritance, lease/fence tests, live continuation
  and interaction routing tests.
- Docs/test worker: API/SDK/CLI docs, AGENTS updates, cleanup searches, final
  verification command list.

## Acceptance Criteria

- A user can set an agent to `anthropic_sdk` or `deepagents` through settings,
  CLI, Control API, SDK, or approved admin tool.
- Existing Anthropic SDK behavior still works for Anthropic-compatible models.
- DeepAgents can run an OpenAI endpoint model through Gantry's model gateway.
- DeepAgents can run an Anthropic API-key endpoint model through Gantry's model
  gateway when official docs and integration tests support it.
- Anthropic SDK plus an OpenAI endpoint model is rejected before runner spawn.
- DeepAgents plus Claude OAuth/subscription credentials is rejected unless
  official support is verified and implemented later.
- Jobs and conversations inherit the bound agent's engine.
- No public `job.harness`, job-level `executionProviderId`, raw provider model
  id, raw provider credential, provider-native tool name, DeepAgents backend id,
  or Claude settings path becomes durable authority.
- Memory, jobs, permissions, MCP, browser, sandbox, sessions, and audit remain
  Gantry-owned.
- Raw DeepAgents `execute` and filesystem authority are disabled or mapped to
  Gantry permission, sandbox, protected-path, egress, and audit policy.

## Test Plan

Focused unit tests:

- settings parse/render/import/export for default and per-agent engine;
- Control API, SDK, CLI, and admin tool validation;
- model route matrix for all valid and invalid engine/provider combinations;
- adapter registry rejects unknown or unsupported execution providers;
- gateway env projection never leaks raw provider credentials to tool env;
- DeepAgents adapter normalizes runner frames to existing runtime contracts;
- raw DeepAgents `.mcp.json`, `LocalShellBackend`, `execute`, and filesystem
  authority are denied unless routed through Gantry policy;
- route-aware memory client uses catalog/gateway routes and preserves memory
  scope isolation.

Integration tests:

- OpenAI endpoint DeepAgents model run through the model gateway;
- Anthropic endpoint DeepAgents model run through the model gateway when
  supported;
- Anthropic SDK regression for Claude OAuth/subscription lane;
- scheduled job inherits agent engine, claims lease before execution, and fences
  terminal/provider writes;
- live turn continuation, stop, close-stdin, and interaction resolution reach
  the durable owner;
- pending interaction row is durable before DeepAgents-visible prompt rendering;
- memory evidence -> dreaming promotion/review -> `memory_search` -> fresh-run
  hydration under DM and channel scopes;
- production sandbox guard rejects unsafe DeepAgents shell/filesystem setup.

Cleanup searches before handoff or PR:

```bash
rg -n "job\\.harness|harness\\s*:|executionProviderId.*job|job.*executionProviderId" apps/core/src packages/contracts/src docs
rg -n "LocalShellBackend|BackendProtocol|execute\\b|\\.mcp\\.json|filesystem permissions|interrupt_on" apps/core/src packages/contracts/src docs --glob '!docs/architecture/deepagents-*'
rg -n "ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN" apps/core/src packages/contracts/src docs
rg -n "deepagents|DeepAgents" apps/core/src packages/contracts/src docs --glob '!docs/architecture/deepagents-*'
```

Final verification commands:

- Run the smallest relevant unit/integration tests after each slice.
- For Postgres-backed checks, use a disposable Postgres with required
  extensions per `docs/architecture/current-verification-commands.md`.
- End with `npm run build`, `npm test`, `python3 .codex/scripts/verify.py`, and
  `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`.

## Surface Impact Matrix

| Surface | Status | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Resolves `agentEngine + modelAlias` into a harness adapter and endpoint route. |
| `settings.yaml` | Changed | Adds `defaults.agent_engine` and `agents.<id>.agent_engine`. |
| Postgres/runtime projection | Changed | Projects resolved engine into runtime agent config and run diagnostics; prefer existing run/session tables unless a real missing field is proven. |
| Control API | Changed | Agent read/write and model preview include `agentEngine` and compatibility errors. |
| SDK/contracts | Changed | Adds `AgentEngine`, supported engine metadata, and validation error shapes. |
| CLI | Changed | Agent engine set/show/list and model why output show engine and compatibility. |
| Gantry MCP tools/admin skill | Changed | Settings/admin tools can request reviewed engine updates. |
| Channel/provider adapters | Unchanged by design | Channels render canonical status/errors only; no channel-specific engine authority. |
| Docs/prompts | Changed | Existing alias-only/internal harness wording must be replaced. |
| Audit/events | Changed | Engine changes and resolved run engine/provider/endpoint must be auditable. |
| Tests/verification | Changed | Adds matrix, adapter, memory, job/live, sandbox, and leakage coverage. |

## Locked Decisions

- Public noun: agent engine.
- Public values: `anthropic_sdk`, `deepagents`.
- Durable scope: per-agent, with optional default for newly configured agents.
- Jobs and conversations inherit engine in v1; no job-level or conversation-level
  engine override.
- `modelAlias` chooses model; provider route chooses endpoint family; agent
  engine chooses harness.
- `executionProviderId` remains internal/read-only diagnostic.
- Anthropic SDK remains the Claude OAuth/subscription lane.
- DeepAgents is the API-key engine for supported OpenAI and Anthropic endpoint
  routes.
- Gantry remains authoritative for memory, jobs, tools, MCP, skills, browser,
  permissions, sandbox, sessions, settings, and audit.
- Raw DeepAgents shell/filesystem/backend authority is disabled unless routed
  through Gantry policy.
