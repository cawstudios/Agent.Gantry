export interface CustomerIdentity {
  phone?: string | null;
  email?: string | null;
}

export interface GuardInput {
  callerPhone?: string;
  callerEmail?: string;
  customer: CustomerIdentity;
}

export type GuardResult =
  | { ok: true; matchedVia: 'phone' | 'email' }
  | { ok: false; reason: 'IDENTITY_MISMATCH' };

const DEFAULT_COUNTRY_CODE = '91';

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/[\s\-()]/g, '');
  if (!stripped) return null;

  if (stripped.startsWith('+')) {
    const digits = stripped.slice(1).replace(/\D/g, '');
    return digits ? `+${digits}` : null;
  }

  const digitsOnly = stripped.replace(/\D/g, '');
  if (!digitsOnly) return null;

  // Leading-zero local: drop the 0, prepend default country code.
  if (digitsOnly.startsWith('0') && digitsOnly.length === 11) {
    return `+${DEFAULT_COUNTRY_CODE}${digitsOnly.slice(1)}`;
  }

  // 10-digit Indian local.
  if (digitsOnly.length === 10) return `+${DEFAULT_COUNTRY_CODE}${digitsOnly}`;

  // Already includes a country code without the plus.
  return `+${digitsOnly}`;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Verify that the caller controls at least one identity axis on the customer
 * record. Phone and email are equally-valid axes — if either matches, the
 * verification succeeds.
 */
export function verifyIdentity(input: GuardInput): GuardResult {
  const callerPhone = normalizePhone(input.callerPhone);
  const customerPhone = normalizePhone(input.customer.phone);

  if (callerPhone && customerPhone && callerPhone === customerPhone) {
    return { ok: true, matchedVia: 'phone' };
  }

  const callerEmail = normalizeEmail(input.callerEmail);
  const customerEmail = normalizeEmail(input.customer.email);
  if (callerEmail && customerEmail && callerEmail === customerEmail) {
    return { ok: true, matchedVia: 'email' };
  }

  return { ok: false, reason: 'IDENTITY_MISMATCH' };
}
