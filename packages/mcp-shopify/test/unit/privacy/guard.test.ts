import { describe, expect, it } from 'vitest';
import {
  normalizeEmail,
  normalizePhone,
  verifyIdentity,
} from '../../../src/privacy/guard.js';

describe('normalizePhone', () => {
  it('accepts already-canonical international format', () => {
    expect(normalizePhone('+919876543210')).toBe('+919876543210');
  });

  it('strips whitespace and dashes', () => {
    expect(normalizePhone('+91-98765-43210')).toBe('+919876543210');
    expect(normalizePhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalizePhone(' +91 (98765) 43210 ')).toBe('+919876543210');
  });

  it('defaults country code for 10-digit local numbers', () => {
    expect(normalizePhone('9876543210')).toBe('+919876543210');
  });

  it('handles leading-zero 11-digit local numbers', () => {
    expect(normalizePhone('09876543210')).toBe('+919876543210');
  });

  it('returns null for empty input', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Hello@Example.COM  ')).toBe('hello@example.com');
  });

  it('returns null for empty', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe('verifyIdentity', () => {
  it('matches on phone in canonical form', () => {
    const result = verifyIdentity({
      callerPhone: '+919876543210',
      customer: { phone: '+919876543210', email: 'a@b.com' },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.matchedVia).toBe('phone');
  });

  it('matches across phone formatting variations', () => {
    const result = verifyIdentity({
      callerPhone: '9876543210',
      customer: { phone: '+91-98765-43210', email: 'a@b.com' },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.matchedVia).toBe('phone');
  });

  it('matches on email when phone mismatches (email is equally-valid identity axis)', () => {
    const result = verifyIdentity({
      callerPhone: '+919800000999',
      callerEmail: 'AANYA@example.com',
      customer: { phone: '+919876543210', email: 'aanya@example.com' },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.matchedVia).toBe('email');
  });

  it('matches on email when only email is supplied (email-only customer)', () => {
    const result = verifyIdentity({
      callerEmail: 'aanya@example.com',
      customer: { phone: null, email: 'aanya@example.com' },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.matchedVia).toBe('email');
  });

  it('fails with IDENTITY_MISMATCH when no axis matches and no email is provided', () => {
    const result = verifyIdentity({
      callerPhone: '+919800000999',
      customer: { phone: '+919876543210', email: 'a@b.com' },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('IDENTITY_MISMATCH');
  });

  it('fails with IDENTITY_MISMATCH when both phone and email mismatch', () => {
    const result = verifyIdentity({
      callerPhone: '+919800000999',
      callerEmail: 'someone-else@example.com',
      customer: { phone: '+919876543210', email: 'aanya@example.com' },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('IDENTITY_MISMATCH');
  });
});
