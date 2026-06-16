# Extension Scope and Sandbox Plan

Status: future product-slice plan for LOCAL-36. This is not implementation
evidence.

## 1. Problem

Delegated work multiplies extension surfaces: skills, MCP servers, tools,
filesystem access, shells, browser, memory, egress, and sandbox backends. Gantry
must keep those scopes explicit and fail closed instead of inheriting raw
provider defaults.

## 2. Scope / Non-goals

In scope:

- Parent and delegated skill, MCP, tool, browser, memory, filesystem, shell,
  egress, and credential scopes.
- Fail-closed handling for MCP prompts, resources, roots, sampling, elicitation,
  tasks, auth, icons, annotations, and schema metadata.
- Sandbox warmup that is authority-free until a run is claimed.
- DeepAgents backend and raw execute/filesystem denial unless Gantry owns the
  facade and sandbox boundary.

Non-goals:

- No raw `.mcp.json` or direct third-party MCP config.
- No raw DeepAgents filesystem/shell/backend authority.
- No warmed provider sessions, credentials, MCP clients, memory, workspace
  overlays, browser tokens, or transient grants.
- No global skill or host config discovery.

## 3. Acceptance Criteria

- Main and delegated scopes replace or explicitly inherit bounded selections;
  they never accidentally merge raw provider defaults.
- MCP protocol features beyond basic selected tools remain unavailable unless a
  reviewed adapter flow exists.
- Skill frontmatter discovery, full `SKILL.md` reads, helper scripts, modules,
  templates, and sandbox sync happen only after match and authority.
- Sandbox warm templates contain no selected authority or per-run secret.
- Per-run credential and egress injection happens only after claim and policy.
- Stale leases or fences cannot reuse sandbox state.

## 4. Technical Approach

Create scope descriptors for parent and delegated work. Provider adapters
receive only Gantry-selected projections. Sandbox providers expose readiness and
template diagnostics but activate per-run authority only after lifecycle claim.

### Surface Impact Matrix

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Delegated scopes and sandbox activation become explicit. |
| `settings.yaml` | Deferred | Durable scope defaults need separate desired-state approval. |
| Postgres/runtime projection | Changed | Scope, audit, and sandbox activation evidence may need rows/read models. |
| Control API | Deferred | Scope diagnostics need a separate API decision. |
| SDK/contracts | Changed | Adapter scope descriptors and sandbox diagnostics change. |
| CLI | Unchanged by design | No direct local surface is needed for scope enforcement. |
| Gantry MCP tools/admin skill | Changed | MCP/tool capability behavior and diagnostics may change. |
| Channel/provider adapters | Changed | Providers receive narrowed projections; channels remain descriptor-driven. |
| Docs/prompts | Changed | Scope and sandbox boundaries must be documented. |
| Audit/events | Changed | Scope projection, denial, egress, and sandbox decisions are audited. |
| Tests/verification | Changed | Raw-denial, MCP, skill, and sandbox tests are required. |

## 5. Task Decomposition

1. Define parent/delegated scope descriptors for tools, skills, MCP, memory,
   browser, filesystem, shell, egress, and credentials.
2. Preserve selected-skill progressive disclosure across main and delegated
   scopes.
3. Keep MCP prompts/resources/sampling/elicitation/tasks/auth fail-closed.
4. Add sandbox readiness/activation diagnostics and stale fence tests.
5. Add cleanup searches for raw provider extension names.

## 6. Risks

- Provider default tools can reappear through helper APIs.
- DeepAgents filesystem permissions do not cover custom tools, MCP tools, or raw
  sandbox execute behavior.
- Warm sandbox state can accidentally carry credentials or selected authority.

## 7. Verify Plan

- DeepAgents raw authority denial tests.
- MCP proxy/list/call tests.
- Skill projection and source isolation tests.
- Sandbox provider and stale lease/fence tests.
- Cleanup searches for raw MCP, task, shell, filesystem, and config surfaces.
