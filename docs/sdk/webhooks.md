# Outbound Webhooks

Gantry outbound webhooks are host-owned callback destinations. Agents do not
choose webhook URLs. They deliver durable runtime events to an application after
Gantry has accepted work.

Do not use `/v1/webhooks` for inbound authority. Signed inbound systems use
external ingress records under `/v1/ingresses`.

## Delivery behavior

- signed with HMAC-SHA256
- at-least-once delivery
- retry on timeout, `408`, `429`, and `5xx`
- dead-letter after bounded retries
- replay and purge APIs for dead letters

## Headers

- `x-gantry-webhook-id`
- `x-gantry-webhook-timestamp`
- `x-gantry-webhook-event`
- `x-gantry-webhook-signature`
- `x-gantry-correlation-id` when present

## Signature verification

```ts
import { verifyWebhookSignature } from '@gantry/sdk';

export async function POST(req: Request) {
  const rawBody = await req.text();
  const ok = verifyWebhookSignature({
    secret: process.env.GANTRY_WEBHOOK_SECRET!,
    timestamp: req.headers.get('x-gantry-webhook-timestamp')!,
    eventId: req.headers.get('x-gantry-webhook-id')!,
    eventType: req.headers.get('x-gantry-webhook-event')!,
    signature: req.headers.get('x-gantry-webhook-signature')!,
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

Deduplicate on `x-gantry-webhook-id`. The same event may be delivered more than once. The SDK verifier rejects timestamps outside a 5 minute tolerance by default; keep a durable processed-event table for side effects.
