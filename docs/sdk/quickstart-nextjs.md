# Next.js Quickstart

```ts
// app/api/agent/route.ts
import { createClient } from '@myclaw/sdk';

const client = createClient({
  socketPath: process.env.MYCLAW_CONTROL_SOCKET_PATH,
  apiKey: process.env.MYCLAW_SESSIONS_API_KEY!,
});

export async function POST(req: Request) {
  const body = await req.json();
  const user = await requireAuthenticatedUser(req);
  const conversationId = await resolveUserConversationId(
    user.id,
    body.conversationId,
  );
  const webhookId = await resolveUserWebhookId(user.id);

  const session = await client.sessions.ensure({
    appId: 'nextjs-app',
    conversationId,
    title: body.title,
    responseMode: 'both',
    webhookId,
  });

  const accepted = await client.sessions.sendMessage({
    sessionId: session.sessionId,
    message: body.message,
    senderId: user.id,
    senderName: user.name,
  });

  const result = await client.sessions.wait(session.sessionId, {
    afterEventId: accepted.acceptedEventId,
    timeoutMs: 120_000,
  });

  return Response.json({
    session,
    accepted,
    result,
  });
}
```

## Streaming in a route handler

```ts
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId')!;
  const afterEventId = Number(url.searchParams.get('afterEventId') || 0);
  const user = await requireAuthenticatedUser(req);
  await assertUserCanReadSession(user.id, sessionId);

  const stream = new ReadableStream({
    async start(controller) {
      for await (const event of client.sessions.stream(sessionId, {
        afterEventId,
      })) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
```
