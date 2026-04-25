# Webhooks

MyClaw webhooks are host-owned callback destinations. Agents do not choose webhook URLs.

## Delivery behavior

- signed with HMAC-SHA256
- at-least-once delivery
- retry on timeout, `408`, `429`, and `5xx`
- dead-letter after bounded retries
- replay and purge APIs for dead letters

## Headers

- `x-myclaw-webhook-id`
- `x-myclaw-webhook-timestamp`
- `x-myclaw-webhook-event`
- `x-myclaw-webhook-signature`
- `x-myclaw-correlation-id` when present

## Signature verification

```ts
import { verifyWebhookSignature } from '@myclaw/sdk';

export async function POST(req: Request) {
  const rawBody = await req.text();
  const ok = verifyWebhookSignature({
    secret: process.env.MYCLAW_WEBHOOK_SECRET!,
    timestamp: req.headers.get('x-myclaw-webhook-timestamp')!,
    eventId: req.headers.get('x-myclaw-webhook-id')!,
    eventType: req.headers.get('x-myclaw-webhook-event')!,
    signature: req.headers.get('x-myclaw-webhook-signature')!,
    rawBody,
    toleranceMs: 5 * 60_000,
  });

  if (!ok) {
    return new Response('invalid signature', { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  return Response.json({ ok: true, payload });
}
```

## Replay safety

Deduplicate on `x-myclaw-webhook-id`. The same event may be delivered more than once. The SDK verifier rejects timestamps outside a 5 minute tolerance by default; keep a durable processed-event table for side effects.
