import { isIP } from 'net';

export interface OnecliUrlValidationResult {
  ok: boolean;
  normalizedUrl?: string;
  error?: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost') return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.split('.')[0] === '127';
  if (ipVersion === 6) return normalized === '::1';
  return false;
}

export function validateOnecliUrl(rawUrl: string): OnecliUrlValidationResult {
  const input = rawUrl.trim();
  if (!input) {
    return { ok: false, error: 'ONECLI_URL is required.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: 'ONECLI_URL must be a valid URL.' };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: 'ONECLI_URL must not contain embedded credentials.',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: 'ONECLI_URL must use http:// or https://.',
    };
  }

  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    return {
      ok: false,
      error: 'ONECLI_URL must use HTTPS unless it points to loopback.',
    };
  }

  parsed.hash = '';
  return { ok: true, normalizedUrl: parsed.toString().replace(/\/$/, '') };
}

export function assertValidOnecliUrl(rawUrl: string): string {
  const result = validateOnecliUrl(rawUrl);
  if (!result.ok || !result.normalizedUrl) {
    throw new Error(result.error || 'Invalid ONECLI_URL.');
  }
  return result.normalizedUrl;
}
import net from 'net';
