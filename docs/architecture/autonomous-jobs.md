# Autonomous Jobs

Autonomous jobs are runtime state, not desired-state configuration. Recurring,
one-time, and manually triggered scheduler jobs are stored in Postgres and must
not be written to `settings.yaml`.

## Capability Policy

At execution time, a job resolves its target agent from the runtime target:
`group_scope` plus `execution_context` (`conversationJid`, optional `threadId`,
optional `sessionId`). The job inherits that target agent's currently selected
tool bindings for the run.

Job-scoped extra tool rules are persisted in `jobs.target_json` under:

```json
{
  "capabilityPolicy": {
    "allowedTools": [
      "Bash(dedup-append-lead.py *)",
      "Read(/Users/me/project/notes.md)"
    ]
  }
}
```

Missing `capabilityPolicy.allowedTools` means an empty extra-tool list.
These rules are stored on the job only. They are never mirrored into
`settings.yaml`; inherited agent grants are resolved dynamically from the target
agent and shown separately.

Allowed job tool rules support exact tool names, registered scoped SDK tool
rules such as `Tool(scope-pattern)`, and `mcp__server__*`. Scoped rules are
evaluated by `apps/core/src/shared/tool-rule-matcher.ts`; new tools must be
registered there with allow/deny tests before they can be used in scheduled job
policy. Empty rules, global `*`, unregistered scoped tools, and other wildcard
forms are invalid. Jobs cannot add admin-only MyClaw tools as extras unless the
originating agent has the selected capability and the originating conversation
approval policy allows it.

Jobs also cannot add raw Browser action MCP rules such as
`mcp__agent_browser__*`, `mcp__playwright__*`, or `mcp__puppeteer__*`, and
cannot add projected `mcp__myclaw__browser_*` tools as job-scoped extras.
Request persistent `Browser` capability for the agent first; jobs then use the
projected tools inherited from that capability.

## Execution

Scheduled job execution keeps protected capability and memory guards active
before autonomous allowance. It must not write permission IPC or wait for chat
approval during execution. If a tool is outside the effective job allowlist, the
runner denies it immediately with:

```text
Tool not on autonomous job allowlist: Bash.
Recovery: scheduler_grant_tool { "job_id": "job-1", "rule": "Bash(git status --short)" }
```

If a safe scoped `Bash(<command>)` rule cannot represent the requested command,
fallback to broad `Bash` should require manual review.

The scheduler records the failure summary, emits `job.tool_denied`, and notifies
the linked group/thread or DM unless the job is silent.

Host-owned job scripts are not supported. Raw host Bash is not equivalent to
Claude SDK Bash because it does not inherit the SDK filesystem sandbox,
provider tool lifecycle, or per-tool permission callback. Move job logic into
the scheduled prompt and grant exact SDK tools with `scheduler_grant_tool`. Any
future script-like job runner must first provide the same protected-path
deny-write boundary on macOS, Linux, and Docker deployments.

`scheduler_grant_tool` is the agent-facing recovery path for job-local tools.
It reads the current job, appends one rule if absent, and writes the updated
`target_json.capabilityPolicy.allowedTools` through the normal scheduler update
IPC path after validating the rule. It is not a settings-owned persistent agent
grant.

## Visibility

Jobs are inspectable through chat scheduler tools, Control API, SDK, and CLI.
List/detail output should include the target, schedule, status, model, prompt,
`executionContext`, `notificationRoutes`, and one canonical `toolAccess`
object:

```json
{
  "toolAccess": {
    "inheritedAgentTools": ["Read", "Bash(git status *)"],
    "jobExtraTools": ["Read(/Users/me/project/notes.md)"],
    "effectiveAllowedTools": [
      "Read",
      "Bash(git status *)",
      "Read(/Users/me/project/notes.md)"
    ],
    "source": "inherited agent grants plus target_json.capabilityPolicy.allowedTools"
  }
}
```

Normal agent-facing scheduler MCP tools are not an admin surface. They may list,
read, mutate, inspect runs/events, inspect dead letters, and manually queue runs
only for jobs whose `group_scope` equals the calling agent group and whose
`execution_context.conversationJid` matches the originating conversation.
Threads/topics remain delivery metadata for notifications and spoof checks: a
thread id may be checked to prevent a caller from retargeting delivery outside
the authenticated thread, but it never grants job visibility or run authority.

Admin-wide job visibility and triggering remain on the Control API, SDK, and
local/admin CLI surfaces.
