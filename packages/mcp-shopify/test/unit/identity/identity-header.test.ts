import { describe, expect, it } from 'vitest';
import {
  canonicalIdentityString,
  computeIdentitySignature,
  verifyIdentityHeader,
} from '../../../src/identity/identity-header.js';

const SECRET = 'test-secret-do-not-use-in-prod';

function signedHeader(opts: {
  phone?: string;
  email?: string;
  ts: number;
  secret?: string;
}): string {
  const sig = computeIdentitySignature(
    { phone: opts.phone, email: opts.email, ts: opts.ts },
    opts.secret ?? SECRET,
  );
  const parts: string[] = [];
  if (opts.phone) parts.push(`phone:${opts.phone}`);
  if (opts.email) parts.push(`email:${opts.email}`);
  parts.push(`ts:${opts.ts}`);
  parts.push(`sig:${sig}`);
  return parts.join(';');
}

describe('canonicalIdentityString', () => {
  it('is deterministic across phone/email/ts inputs', () => {
    const s1 = canonicalIdentityString({
      phone: '+919876543210',
      email: 'a@b.com',
      ts: 1700000000,
    });
    const s2 = canonicalIdentityString({
      phone: '+919876543210',
      email: 'a@b.com',
      ts: 1700000000,
    });
    expect(s1).toBe(s2);
  });

  it('lowercases email for canonical form', () => {
    expect(canonicalIdentityString({ email: 'A@B.COM', ts: 1 })).toBe(
      'phone=|email=a@b.com|ts=1',
    );
  });

  it('uses empty strings for missing fields', () => {
    expect(canonicalIdentityString({ phone: '+91', ts: 9 })).toBe(
      'phone=+91|email=|ts=9',
    );
  });
});

describe('verifyIdentityHeader', () => {
  const NOW = 1700000000 * 1000;
  const now = () => NOW;

  it('returns absent when header is missing or empty', () => {
    expect(
      verifyIdentityHeader(undefined, { secret: SECRET, now }).kind,
    ).toBe('absent');
    expect(verifyIdentityHeader('', { secret: SECRET, now }).kind).toBe(
      'absent',
    );
    expect(verifyIdentityHeader('   ', { secret: SECRET, now }).kind).toBe(
      'absent',
    );
  });

  it('accepts a correctly-signed header (phone only)', () => {
    const header = signedHeader({ phone: '+919876543210', ts: 1700000000 });
    const result = verifyIdentityHeader(header, { secret: SECRET, now });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.identity.phone).toBe('+919876543210');
      expect(result.identity.email).toBeUndefined();
    }
  });

  it('accepts a correctly-signed header with phone and email', () => {
    const header = signedHeader({
      phone: '+919876543210',
      email: 'A@b.COM',
      ts: 1700000000,
    });
    const result = verifyIdentityHeader(header, { secret: SECRET, now });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.identity.email).toBe('a@b.com');
    }
  });

  it('rejects a tampered signature', () => {
    const header =
      signedHeader({ phone: '+919876543210', ts: 1700000000 }) + 'xx';
    const result = verifyIdentityHeader(header, { secret: SECRET, now });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBe('BAD_SIGNATURE');
    }
  });

  it('rejects when the wrong secret is used to sign', () => {
    const header = signedHeader({
      phone: '+919876543210',
      ts: 1700000000,
      secret: 'wrong-secret',
    });
    const result = verifyIdentityHeader(header, { secret: SECRET, now });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBe('BAD_SIGNATURE');
    }
  });

  it('rejects when the server has no secret configured', () => {
    const header = signedHeader({ phone: '+919876543210', ts: 1700000000 });
    const result = verifyIdentityHeader(header, { now });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBe('NO_SECRET_CONFIGURED');
    }
  });

  it('rejects a stale timestamp beyond maxAgeSec', () => {
    const header = signedHeader({
      phone: '+919876543210',
      ts: 1700000000 - 120, // 2 minutes ago
    });
    const result = verifyIdentityHeader(header, {
      secret: SECRET,
      maxAgeSec: 60,
      now,
    });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBe('STALE_TIMESTAMP');
    }
  });

  it('rejects a far-future timestamp', () => {
    const header = signedHeader({
      phone: '+919876543210',
      ts: 1700000000 + 3600, // 1 hour in the future
    });
    const result = verifyIdentityHeader(header, { secret: SECRET, now });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBe('FUTURE_TIMESTAMP');
    }
  });

  it('rejects malformed headers', () => {
    expect(
      verifyIdentityHeader('garbage', { secret: SECRET, now }).kind,
    ).toBe('invalid');
    expect(
      verifyIdentityHeader('phone:+91', { secret: SECRET, now }).kind,
    ).toBe('invalid');
    expect(
      verifyIdentityHeader('ts:1700000000;sig:abc', { secret: SECRET, now })
        .kind,
    ).toBe('invalid');
  });

  it('rejects when neither phone nor email is supplied', () => {
    const sig = computeIdentitySignature(
      { ts: 1700000000 },
      SECRET,
    );
    const result = verifyIdentityHeader(`ts:1700000000;sig:${sig}`, {
      secret: SECRET,
      now,
    });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBe('MISSING_FIELDS');
    }
  });
});
