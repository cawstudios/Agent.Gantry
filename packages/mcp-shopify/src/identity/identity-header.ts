import crypto from 'node:crypto';

export const IDENTITY_HEADER_NAME = 'x-caller-identity';

export interface VerifiedIdentity {
  phone?: string;
  email?: string;
  issuedAtMs: number;
}

export interface VerifyHeaderOptions {
  secret?: string;
  maxAgeSec?: number;
  now?: () => number;
}

export type VerifyHeaderResult =
  | { kind: 'absent' }
  | { kind: 'ok'; identity: VerifiedIdentity }
  | {
      kind: 'invalid';
      reason:
        | 'NO_SECRET_CONFIGURED'
        | 'MALFORMED'
        | 'MISSING_FIELDS'
        | 'BAD_SIGNATURE'
        | 'STALE_TIMESTAMP'
        | 'FUTURE_TIMESTAMP';
    };

const DEFAULT_MAX_AGE_SEC = 60;

interface Parsed {
  phone?: string;
  email?: string;
  ts?: string;
  sig?: string;
}

function parsePairs(raw: string): Parsed {
  const result: Parsed = {};
  for (const segment of raw.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (!value) continue;
    if (key === 'phone') result.phone = value;
    else if (key === 'email') result.email = value;
    else if (key === 'ts') result.ts = value;
    else if (key === 'sig') result.sig = value;
  }
  return result;
}

export function canonicalIdentityString(input: {
  phone?: string;
  email?: string;
  ts: number;
}): string {
  return [
    `phone=${input.phone ?? ''}`,
    `email=${(input.email ?? '').toLowerCase()}`,
    `ts=${input.ts}`,
  ].join('|');
}

export function computeIdentitySignature(
  input: { phone?: string; email?: string; ts: number },
  secret: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(canonicalIdentityString(input))
    .digest('hex');
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function verifyIdentityHeader(
  raw: string | undefined,
  opts: VerifyHeaderOptions,
): VerifyHeaderResult {
  if (!raw || raw.trim() === '') return { kind: 'absent' };

  const parsed = parsePairs(raw);
  if (!parsed.ts || !parsed.sig) {
    return { kind: 'invalid', reason: 'MALFORMED' };
  }
  if (!parsed.phone && !parsed.email) {
    return { kind: 'invalid', reason: 'MISSING_FIELDS' };
  }
  if (!opts.secret) {
    return { kind: 'invalid', reason: 'NO_SECRET_CONFIGURED' };
  }

  const ts = Number.parseInt(parsed.ts, 10);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { kind: 'invalid', reason: 'MALFORMED' };
  }

  const expected = computeIdentitySignature(
    { phone: parsed.phone, email: parsed.email, ts },
    opts.secret,
  );
  if (!safeCompare(expected, parsed.sig)) {
    return { kind: 'invalid', reason: 'BAD_SIGNATURE' };
  }

  const nowMs = (opts.now ?? (() => Date.now()))();
  const maxAgeSec = opts.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
  const issuedAtMs = ts * 1000;
  if (nowMs - issuedAtMs > maxAgeSec * 1000) {
    return { kind: 'invalid', reason: 'STALE_TIMESTAMP' };
  }
  if (issuedAtMs - nowMs > 5 * 60 * 1000) {
    return { kind: 'invalid', reason: 'FUTURE_TIMESTAMP' };
  }

  return {
    kind: 'ok',
    identity: {
      phone: parsed.phone,
      email: parsed.email?.toLowerCase(),
      issuedAtMs,
    },
  };
}
