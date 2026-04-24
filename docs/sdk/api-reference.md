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