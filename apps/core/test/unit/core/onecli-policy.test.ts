import { describe, expect, it } from 'vitest';

import { validateOnecliUrl } from '@core/infrastructure/onecli/policy.js';

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
});
