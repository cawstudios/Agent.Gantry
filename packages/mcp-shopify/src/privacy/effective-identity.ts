import { ShopifyAdapterError } from '../errors.js';
import { getVerifiedIdentity } from '../identity/identity-context.js';
import type { VerifiedIdentity } from '../identity/identity-header.js';
import { normalizeEmail, normalizePhone } from './guard.js';

export interface EffectiveIdentity {
  phone?: string;
  email?: string;
  source: 'header' | 'arg' | 'mixed';
}

export interface ResolveOptions {
  callerPhone?: string;
  callerEmail?: string;
}

/**
 * Resolves the effective caller identity used by every privacy-guarded tool.
 *
 * Identity axes (phone, email) are equally valid — a customer may have either
 * or both on their Shopify record. Whichever the caller can prove control of
 * is sufficient.
 *
 * Precedence rules — designed to make prompt-injection of identity impossible:
 *
 *   1. If a verified identity header is present, those values are authoritative.
 *      Args that disagree with the header are rejected as ARG_VS_HEADER_MISMATCH.
 *      Args that introduce a *new* identity axis the header did not authenticate
 *      (e.g. header has phone only, LLM adds callerEmail) are also rejected.
 *   2. With no header, the args become the identity. At least one of phone/email
 *      must be supplied; tools that need identity throw NO_IDENTITY otherwise.
 *
 * Returns the resolved phone/email plus a `source` tag for audit logging.
 */
export function resolveEffectiveIdentity(opts: ResolveOptions): EffectiveIdentity {
  const header = getVerifiedIdentity();
  if (header) {
    enforceHeaderArgConsistency(header, opts);
    return {
      phone: header.phone,
      email: header.email,
      source: opts.callerPhone || opts.callerEmail ? 'mixed' : 'header',
    };
  }
  const normalizedPhone = opts.callerPhone
    ? (normalizePhone(opts.callerPhone) ?? undefined)
    : undefined;
  const normalizedEmail = opts.callerEmail
    ? (normalizeEmail(opts.callerEmail) ?? undefined)
    : undefined;
  if (!normalizedPhone && !normalizedEmail) {
    throw new ShopifyAdapterError(
      'PRIVACY_GUARD_FAILED',
      'callerPhone or callerEmail is required when no verified identity header is present',
      { reason: 'NO_IDENTITY' },
    );
  }
  return {
    phone: normalizedPhone,
    email: normalizedEmail,
    source: 'arg',
  };
}

function enforceHeaderArgConsistency(
  header: VerifiedIdentity,
  args: ResolveOptions,
): void {
  if (args.callerPhone) {
    if (!header.phone) {
      // Header authenticated email but not phone — LLM cannot introduce a
      // phone-axis identity under the header's cover.
      throw new ShopifyAdapterError(
        'PRIVACY_GUARD_FAILED',
        'callerPhone argument was supplied but the channel-verified identity header does not include a phone',
        { reason: 'ARG_VS_HEADER_MISMATCH' },
      );
    }
    if (normalizePhone(args.callerPhone) !== normalizePhone(header.phone)) {
      throw new ShopifyAdapterError(
        'PRIVACY_GUARD_FAILED',
        'callerPhone argument disagrees with the channel-verified identity header',
        { reason: 'ARG_VS_HEADER_MISMATCH' },
      );
    }
  }
  if (args.callerEmail) {
    if (!header.email) {
      throw new ShopifyAdapterError(
        'PRIVACY_GUARD_FAILED',
        'callerEmail argument was supplied but the channel-verified identity header does not include an email',
        { reason: 'ARG_VS_HEADER_MISMATCH' },
      );
    }
    if (normalizeEmail(args.callerEmail) !== normalizeEmail(header.email)) {
      throw new ShopifyAdapterError(
        'PRIVACY_GUARD_FAILED',
        'callerEmail argument disagrees with the channel-verified identity header',
        { reason: 'ARG_VS_HEADER_MISMATCH' },
      );
    }
  }
}
