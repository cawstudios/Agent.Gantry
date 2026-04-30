# Capability Management

MyClaw treats every agent-visible extension as an app-scoped and agent-scoped
capability. A capability can be an SDK tool, a built-in MyClaw MCP tool, a
third-party MCP server, a skill, a browser lifecycle/action capability, or a
channel-native tool. The common rule is request, review, approval or denial,
durable audit, new config version, and next-run activation.

Agents must not mutate capability state directly. They must not run dependency
install commands, edit `.claude/skills`, edit `.mcp.json`, edit Claude
permission settings, edit MyClaw settings, or change generated runtime config.
When a user asks for a new skill, MCP server, dependency, SDK tool, host tool,
or channel capability, the agent calls the matching MyClaw request tool.

## Tool Matrix

| Tool | Use | Never use for |
| --- | --- | --- |
| `send_message` | Progress updates or direct channel messages while the agent is still running. | Persistent capability changes. |
| `ask_user_question` | Structured choices with content, options, single-select, multi-select, preview/details, and channel-native buttons. | Open-ended chat or approval of persistent capabilities. |
| `request_skill_install` | Provider-backed skill installs such as `clawhub:<slug>@<version>`. | Downloading or installing the skill directly. |
| `request_skill_proposal` | Agent-created or modified `SKILL.md` bundles for review. | Writing directly to `.claude/skills`, `.agents/skills`, or agent-local `skills/`. |
| `request_skill_dependency_install` | npm, brew, go, uv, or download dependencies needed by a reviewed skill. | Running dependency commands from the agent. |
| `request_mcp_server` | Third-party MCP server drafts with transport, origin, allowed tool patterns, credential needs, and reason. | Editing `.mcp.json` or Claude `mcpServers`. |
| `request_tool_enable` | SDK or host tools such as `Bash`, `Write`, `Edit`, browser tools, scheduler tools, memory tools, or service tools. | Changing permission settings directly. |
| `request_channel_tool_enable` | Channel-specific capabilities such as Teams proactive messaging, Slack file access, or Telegram file download behavior. | Treating a channel SDK permission as already approved. |
| `service_restart` | Main/admin agent restart after approved config or capability changes that require host restart. | Restarting to activate unapproved changes. |
| `register_agent` | Main/admin agent binding of a new channel conversation to an agent. | Letting a normal agent bind arbitrary chats. |

## Durable Model

Postgres is the durable capability store. It owns definitions, reviewed
versions, agent bindings, config-version links, credential reference names,
permission decisions, audit events, and disablement state.

Readable skill bytes live outside catalog rows:

```text
skills/<skill-slug>/SKILL.md
skills/<skill-slug>/...
skill-drafts/<request-id>/<skill-slug>/SKILL.md
skill-drafts/<request-id>/<skill-slug>/...
```

The database stores metadata, source, content hash, provider refs, binding, and
audit only. Skill files remain readable for review. ClawHub is the default
provider-backed skill source. Provider verification improves review context but
never bypasses approval.

Claude settings, `CLAUDE_CONFIG_DIR`, MCP handoff files, and provider artifacts
are per-run projections. They are compatibility inputs for a provider adapter,
not durable MyClaw truth.

## Lifecycle

1. Request: admin API/SDK/CLI or an agent request tool creates a pending request.
2. Validate: MyClaw checks app scope, agent scope, transport, origin chat,
   credential refs, sandbox profile, tool patterns, and provider metadata.
3. Review: same-channel review renders the request, but authority still comes
   from configured admin/control policy.
4. Decide: approval or denial is recorded with actor, reason, and audit summary.
5. Bind: approval creates or updates the agent binding and a new config version.
6. Materialize: only approved enabled bindings project into the next agent run.
7. Execute: tool use still passes permission and sandbox evaluation.
8. Disable: disabled capabilities stop future materialization without deleting
   history.

## Runtime Projection

The built-in `myclaw` MCP server is host wiring. It is always projected and is
not an admin-managed third-party capability. Third-party MCP servers are
projected only from approved reviewed versions and active bindings. Their
`allowedToolPatterns` form the enforced tool allowlist. Any
`autoApproveToolPatterns` must be a subset of the allowed set.

Skills are projected only when approved and bound. Draft, denied, disabled, or
unbound skill files are never copied into per-run Claude config.

Browser lifecycle tools manage the persistent browser profile. Browser action
tools are a separate runtime-installed capability and attach only on a later run
when a healthy browser is already running at startup.

## Cleanup Rules

Replacement work must remove stale active references to direct shell installs,
global Claude folders, direct `.mcp.json` mutation, group-tied skill state, and
base64 artifact transport. Historical migration references may remain only when
they are clearly historical and not active guidance.
