import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string;
  eventId: string | number;
  eventType: string;
  rawBody: string;
  signature: string;
  toleranceMs?: number;
  nowMs?: number;
}): boolean {
  const timestampMs = Number(input.timestamp);
  const toleranceMs = input.toleranceMs ?? 5 * 60_000;
  if (
    !Number.isFinite(timestampMs) ||
    (toleranceMs >= 0 &&
      Math.abs((input.nowMs ?? Date.now()) - timestampMs) > toleranceMs)
  ) {
    return false;
  }
  const computed = createHmac('sha256', input.secret)
    .update(
      `${input.timestamp}.${input.eventId}.${input.eventType}.${input.rawBody}`,
    )
    .digest('hex');
  const left = Buffer.from(computed);
  const right = Buffer.from(input.signature);
  return left.length === right.length && timingSafeEqual(left, right);
}
