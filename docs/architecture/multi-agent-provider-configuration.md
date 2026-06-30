# Multi-Agent Provider Configuration

This document describes the operator-facing contract for configuring multiple
Gantry agents across provider conversations. It applies to Slack, Teams,
Telegram, and App/Web conversations; provider adapters still own their native
delivery details, while Gantry owns agents, bindings, permissions, sessions, and
runtime routing.

## Mental Model

- A Provider is the channel family: `slack`, `teams`, `telegram`, or `app`.
- A Provider Connection is one installed workspace, tenant, bot, or app
  connection.
- A Conversation is one provider chat surface: Slack channel/DM, Teams
  channel/chat, Telegram group/DM, or App/Web conversation.
- An Agent owns identity, model/persona defaults, attached sources, and selected
  capabilities.
- A Binding connects one agent to one conversation with trigger, sender, memory,
  and approval policy.

The key product rule is simple: install a provider once, create as many agents
as needed, then bind one or more agents to any conversation from that provider.
Multiple agents in one conversation are valid when each binding has its own
trigger policy and capability set.

## Configure Providers

Enable each channel provider through `settings.yaml` or through the Control API /
CLI paths that write the same desired state. Secrets are referenced by
`runtime_secret_refs`; raw provider tokens do not belong in the file.

```yaml
providers:
  slack:
    enabled: true
    default_connection: 'provider_connection:slack-main'
  teams:
    enabled: true
    default_connection: 'provider_connection:teams-main'
  telegram:
    enabled: true
    default_connection: 'provider_connection:telegram-main'

provider_connections:
  'provider_connection:slack-main':
    provider: 'slack'
    label: 'Company Slack'
    runtime_secret_refs:
      bot_token: 'runtime-secret:slack-bot-token'
      signing_secret: 'runtime-secret:slack-signing-secret'
  'provider_connection:teams-main':
    provider: 'teams'
    label: 'Company Teams'
    runtime_secret_refs:
      client_id: 'runtime-secret:teams-client-id'
      client_secret: 'runtime-secret:teams-client-secret'
      tenant_id: 'runtime-secret:teams-tenant-id'
  'provider_connection:telegram-main':
    provider: 'telegram'
    label: 'Ops Telegram Bot'
    runtime_secret_refs:
      bot_token: 'runtime-secret:telegram-bot-token'
```

Provider-specific discovery is setup-only. Slack discovery can list allowed
conversations and search locally after pagination. Teams discovery can use
Microsoft Graph for setup, but live messaging still requires the Teams bot
transport. Telegram membership checks depend on Bot API capabilities and bot
admin limits.

## Create Agents

Use agents for permission variation. Do not model permission differences as
provider-specific channel settings.

```yaml
agents:
  default:
    name: 'Gantry'
    model: 'opus'
    agent_harness: 'auto'
    access:
      selections:
        - id: 'mcp__gantry__send_message'
          version: '1'

  triage:
    name: 'Triage'
    persona: 'operator'
    model: 'sonnet'
    agent_harness: 'auto'
    access:
      preset: locked
      selections:
        - id: 'browser.use'
          version: '1'

  release:
    name: 'Release Manager'
    model: 'opus'
    agent_harness: 'auto'
    access:
      preset: locked
      selections:
        - id: 'mcp__gantry__request_settings_update'
          version: '1'
        - id: 'mcp__gantry__service_restart'
          version: '1'
```

Profile files such as `AGENTS.md` and `SOUL.md` are agent profile state. Agents
request profile changes through the reviewed agent-profile update flow; they do
not edit profile files, provider config, or `settings.yaml` directly.

## Bind Agents To Conversations

With one agent in a conversation, the compact conversation form is enough:

```yaml
conversations:
  'conversation:slack:ops':
    provider: 'slack'
    id: 'C0123456789'
    type: 'channel'
    display_name: '#ops'
    sender_policy:
      allow: '*'
      mode: 'all'
    control_approvers: ['slack:U123']
    agent: 'default'
    trigger: '@gantry'
    requires_trigger: true
```

When two or more agents share a conversation, keep the conversation as the
provider surface and put each agent binding under `bindings`:

```yaml
conversations:
  'conversation:slack:ops':
    provider: 'slack'
    id: 'C0123456789'
    type: 'channel'
    display_name: '#ops'
    sender_policy:
      allow: '*'
      mode: 'all'
    control_approvers: ['slack:U123', 'slack:U456']

bindings:
  'binding:slack:ops:default':
    agent: 'default'
    conversation: 'conversation:slack:ops'
    trigger: '@gantry'
    added_at: '2026-06-30T00:00:00.000Z'
    requires_trigger: true
    memory_scope: 'conversation'

  'binding:slack:ops:triage':
    agent: 'triage'
    conversation: 'conversation:slack:ops'
    trigger: '@triage'
    added_at: '2026-06-30T00:00:00.000Z'
    requires_trigger: true
    memory_scope: 'conversation'
```

The same shape works for Teams, Telegram, and App/Web conversations. Change only
the provider connection and provider external id:

```yaml
conversations:
  'conversation:teams:eng':
    provider: 'teams'
    id: '19:team-id:channel-id'
    type: 'channel'
    display_name: 'Engineering'
    sender_policy:
      allow: '*'
      mode: 'all'

  'conversation:telegram:ops':
    provider: 'telegram'
    id: '-1001234567890'
    type: 'channel'
    display_name: 'Ops Group'
    sender_policy:
      allow: '*'
      mode: 'all'
```

Threads and topics remain provider conversation metadata. Slack threads, Teams
reply chains, and Telegram forum topics inherit the parent conversation's
approvers. Gantry may route internally with agent-qualified queue keys, but
those keys are not provider addresses and should not appear in public setup UX.

## CLI, API, And Agent Tool Usage

All admin surfaces should converge on the same desired-state services:

- CLI setup/onboarding writes `settings.yaml`, appends a settings revision, and
  reconciles runtime projection.
- Control API provider, conversation, agent, and binding endpoints write the
  same desired state for owner/admin automation.
- Gantry MCP admin tools such as `register_agent` are for reviewed
  agent-requested changes and require selected admin capabilities.

The operator flow should be:

1. Install or enable a provider connection.
2. Discover or register provider conversations.
3. Create or update agents with distinct capabilities.
4. Bind agents to conversations.
5. Restart or let runtime projection refresh, depending on the surface used.
6. Verify in the target provider conversation with each binding's trigger.

Agents should use Gantry tools such as `request_access`,
`request_agent_profile_update`, `request_settings_update`, and `register_agent`
when they need reviewed changes. They should not instruct users to edit raw
provider config or bypass the approval/capability lifecycle.

## Runtime Guarantees

- One provider message is stored once.
- Matching bindings may create separate agent-specific admission work.
- Sessions, cursors, live turn ownership, approvals, and tool grants are
  isolated per agent route.
- Provider delivery remains conversation/thread scoped.
- Explicit external ingress agent targeting requires an allowed agent list; a
  conversation-scoped ingress alone cannot pick a higher-privilege agent.

## Operational Checks

After changing provider or binding state, use the smallest checks that prove the
surface changed:

```bash
gantry status
gantry settings export --file /tmp/gantry-settings.yaml
gantry providers list
gantry conversations list --provider slack
gantry agents list
```

Then send provider messages that exercise each binding trigger. In one Slack
channel, for example, `@gantry summarize this thread` and `@triage classify this`
should admit different agents with different capability sets.
