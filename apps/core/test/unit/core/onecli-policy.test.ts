import { describe, expect, it } from 'vitest';

import { validateOnecliUrl } from '@core/adapters/credentials/onecli/policy.js';
import { validateExternalBrokerUrl } from '@core/config/credentials/broker-url-policy.js';

describe('validateOnecliUrl', () => {
  it('allows plaintext only for actual loopback hosts', () => {
    expect(validateOnecliUrl('http://localhost:10254').ok).toBe(true);
    expect(validateOnecliUrl('http://127.0.0.1:10254').ok).toBe(true);
    expect(validateOnecliUrl('http://127.12.34.56:10254').ok).toBe(true);
    expect(validateOnecliUrl('http://[::1]:10254').ok).toBe(true);
  });

  it('does not treat prefix-matching hostnames as loopback', () => {
    const result = validateOnecliUrl('http://127.attacker.com:10254');

    expect(result).toEqual({
      ok: false,
      error: 'ONECLI_URL must use HTTPS unless it points to loopback.',
    });
  });

  it('rejects embedded credentials', () => {
    const result = validateOnecliUrl('https://user:pass@onecli.example.com');

    expect(result).toEqual({
      ok: false,
      error: 'ONECLI_URL must not contain embedded credentials.',
    });
  });

  it('rejects query parameters and fragments', () => {
    expect(validateOnecliUrl('https://onecli.example.com?token=value')).toEqual(
      {
        ok: false,
        error: 'ONECLI_URL must not contain query parameters or fragments.',
      },
    );
    expect(validateOnecliUrl('https://onecli.example.com#token')).toEqual({
      ok: false,
      error: 'ONECLI_URL must not contain query parameters or fragments.',
    });
  });
});

describe('validateExternalBrokerUrl', () => {
  it('uses the same broker-safe URL constraints with ANTHROPIC_BASE_URL diagnostics', () => {
    expect(
      validateExternalBrokerUrl('https://broker.example.com/anthropic'),
    ).toEqual({
      ok: true,
      normalizedUrl: 'https://broker.example.com/anthropic',
    });
    expect(
      validateExternalBrokerUrl('https://user:pass@broker.example.com'),
    ).toEqual({
      ok: false,
      error: 'ANTHROPIC_BASE_URL must not contain embedded credentials.',
    });
    expect(
      validateExternalBrokerUrl('https://broker.example.com?token=value'),
    ).toEqual({
      ok: false,
      error:
        'ANTHROPIC_BASE_URL must not contain query parameters or fragments.',
    });
    expect(
      validateExternalBrokerUrl('https://broker.example.com#token'),
    ).toEqual({
      ok: false,
      error:
        'ANTHROPIC_BASE_URL must not contain query parameters or fragments.',
    });
    expect(validateExternalBrokerUrl('not-a-url')).toEqual({
      ok: false,
      error: 'ANTHROPIC_BASE_URL must be a valid URL.',
    });
    expect(validateExternalBrokerUrl('http://broker.example.com')).toEqual({
      ok: false,
      error: 'ANTHROPIC_BASE_URL must use HTTPS unless it points to loopback.',
    });
  });
});
