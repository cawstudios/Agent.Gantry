# Channel Interactions

MyClaw renders one channel-neutral interaction model across Slack, Telegram,
Teams, Web, API sessions, and agent-initiated requests. Channel adapters own
presentation. Application policy owns authorization.

## InteractionDescriptor

`InteractionDescriptor` is the canonical shape for permission prompts,
capability reviews, structured questions, status cards, final decisions, and
audit summaries.

Fields:

- `title`
- `body`
- `severity`
- `requestContext`
- `options`
- `selectionMode`
- `actions`
- `details`
- `files`
- `dependencies`
- `auditSummary`
- `result`

Descriptors are data, not policy. They can display `send_message`,
`ask_user_question`, `request_skill_install`, `request_skill_proposal`,
`request_skill_dependency_install`, `request_mcp_server`,
`request_tool_enable`, `request_channel_tool_enable`, `service_restart`, and
`register_agent` requests, but approval authority stays with the configured
control/admin rules.

## Slack

Slack renders descriptors with Block Kit sections, fields, context, dividers,
buttons, radio buttons, checkboxes or multi-selects, and modals when the request
needs more room. Unauthorized approvers receive an ephemeral denial. Approval
cards update in place with the final status.

## Telegram

Telegram renders concise HTML messages plus inline keyboards. Single-select
uses one button per option. Multi-select uses toggle buttons plus `Done`.
Details and files are paginated because callback payloads are small. Wrong
chat, stale nonce, replay, and unauthorized users fail closed.

## Teams

Teams is a first-class channel target. Teams renderers use Adaptive Cards and
`Action.Execute` for approvals and prompts. Single-select uses action buttons.
Multi-select uses `Input.ChoiceSet` plus `Done`. Details and files use card
updates, show-card sections, or dialogs where needed. Final decisions update
the original card using Teams activity update. Unauthorized users receive
targeted/private feedback where Teams supports it; otherwise MyClaw sends a
non-sensitive denial update.

## Web And API

Web/API renderers expose the same descriptor as cards, tables, modals, file
browser views, and an audit timeline. API callers must treat descriptors as
rendering contracts; they must not bypass `request_skill_install`,
`request_skill_proposal`, `request_skill_dependency_install`,
`request_mcp_server`, `request_tool_enable`, or
`request_channel_tool_enable` by editing durable state directly.

## Channel Tool Requests

Channel-specific tools are approved capabilities. Examples include Teams
proactive messaging, Slack file access, and Telegram file download behavior.
Agents request them with `request_channel_tool_enable`. A channel provider flag
describes whether the adapter can render or execute an interaction; it is not
an authorization grant.
