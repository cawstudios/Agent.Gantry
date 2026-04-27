# SDK API Reference

## Client

```ts
createClient({
  apiKey,
  socketPath?, // preferred local transport
  baseUrl?,    // optional loopback TCP or remote proxy
  timeoutMs?,
})
```

## Sessions

```ts
client.sessions.ensure({
  appId,
  conversationId,
  title?,
  responseMode?, // sse | webhook | both | none
  webhookId?,
})

client.sessions.sendMessage({
  sessionId,
  message,
  senderId?,
  senderName?,
  threadId?,
  correlationId?,
  responseMode?,
  webhookId?,
})

client.sessions.listEvents(sessionId, afterEventId?)
client.sessions.stream(sessionId, { afterEventId?, signal? })
client.sessions.wait(sessionId, { afterEventId?, timeoutMs? })
```

Read-only history endpoints are available over the control API. SDK helpers are
not exposed for these endpoints yet.

```http
GET /v1/sessions/:sessionId
GET /v1/sessions/:sessionId/messages?limit=100
GET /v1/sessions/:sessionId/runs?limit=100
```

Responses are scoped by the API key's app access. Session history is backed by
Postgres `AgentSession`, `Message`, `AgentRun`, and `ProviderSession` records.

## Jobs

```ts
client.jobs.create({
  name,
  prompt,
  sessionId,
  kind?, // manual | once | recurring
  runAt?, // once
  schedule?, // recurring
  executionMode?, // parallel | serialized
  threadId?,
  model?,
})

client.jobs.list()
client.jobs.get(jobId)
client.jobs.update(jobId, patch)
client.jobs.delete(jobId)
client.jobs.pause(jobId)
client.jobs.resume(jobId)
client.jobs.trigger(jobId)
client.jobs.wait(triggerId, timeoutMs?)
```

## Runs

```ts
client.runs.list(jobId?)
client.runs.get(runId)
```

Read-only run event history is available over the control API:

```http
GET /v1/runs/:runId/events
```

## Channels

Channel installation APIs are app-bound by the API key. Channel credentials are
stored as `runtimeSecretRefs`; raw tokens and secrets are rejected by the
control API.

```ts
client.channels.providers.list()

client.channels.installations.create({
  appId,
  providerId, // app | telegram | slack
  label,
  config?,
  externalRef?,
  runtimeSecretRefs?,
  enabled?,
})

client.channels.installations.list()
client.channels.installations.get(installationId)
client.channels.installations.update(installationId, {
  label?,
  status?,
  config?,
  externalRef?,
  runtimeSecretRefs?,
  enabled?,
})
client.channels.installations.delete(installationId)
client.channels.installations.discover(installationId, {
  query?,
  limit?,
  includeArchived?,
})

client.channels.conversations.list({ channelInstallationId? })
client.channels.conversations.get(conversationId)
client.channels.conversations.messages(conversationId, {
  threadId?,
  after?,
  limit?,
})
```

Control API scopes:

```http
GET    /v1/channel-providers                       channels:read
POST   /v1/channel-installations                   channels:admin
GET    /v1/channel-installations                   channels:read
GET    /v1/channel-installations/:id               channels:read
PATCH  /v1/channel-installations/:id               channels:admin
DELETE /v1/channel-installations/:id               channels:admin
POST   /v1/channel-installations/:id/discover      channels:admin

GET    /v1/conversations                           conversations:read
GET    /v1/conversations/:id                       conversations:read
GET    /v1/conversations/:id/threads               conversations:read
GET    /v1/conversations/:id/messages              messages:read
```

`teams` and `whatsapp` are returned as unavailable placeholders until their
adapters are implemented.

## Agent Channel Bindings

```ts
client.agents.bindings.list(agentId)
client.agents.bindings.enable(agentId, conversationId, {
  channelInstallationId?,
  threadId?,
  displayName?,
  triggerMode?, // always | mention | keyword | manual | webhook
  triggerPattern?,
  requiresTrigger?,
  isAdminBinding?,
  memoryScope?, // user | conversation | thread | agent | app
  memorySubject?,
  workspaceSnapshotId?,
  permissionPolicyIds?,
})
client.agents.bindings.update(agentId, conversationId, patch)
client.agents.bindings.disable(agentId, conversationId, { threadId? })
```

Binding writes require `agents:admin`. `disable()` marks the binding disabled;
it does not delete the row.

## Memory

Memory APIs are app-bound by the API key. Pass stable `appId`, `agentId`,
`userId`, `groupId`, `channelId`, and `threadId` when your application has them.
`common` memory is app-wide and requires admin memory scope to write.

```ts
client.memory.save({
  appId?,
  agentId?,
  userId?,
  groupId?,
  channelId?,
  threadId?,
  subjectType?, // user | group | channel | common
  subjectId?,
  kind?,        // fact | preference | decision | correction | constraint | project_fact | reference
  key,
  value,
  why?,
  confidence?,
  evidenceText?,
})

client.memory.search({
  appId?,
  agentId?,
  userId?,
  groupId?,
  channelId?,
  threadId?,
  query?,
  limit?,
  includeCommon?,
  subjectTypes?,
})

client.memory.list({ appId?, agentId?, userId?, groupId?, channelId? })
client.memory.patch(memoryId, { appId?, agentId?, expectedVersion?, key?, value?, why?, confidence?, isPinned? })
client.memory.delete(memoryId, { appId?, agentId? })
client.memory.dreaming.trigger({ appId?, agentId?, subjectType?, subjectId?, phase?, dryRun? })
client.memory.dreaming.status({ appId?, agentId? })
```

## Webhooks

```ts
client.webhooks.register({ name, url, secret?, enabled? })
client.webhooks.list()
client.webhooks.update(webhookId, { name?, url?, secret?, enabled? })
client.webhooks.delete(webhookId)
client.webhooks.test(webhookId)
client.webhooks.replayDeadLetter(webhookId)
client.webhooks.purgeDeadLetter(webhookId)
```
