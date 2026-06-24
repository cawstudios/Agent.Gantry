import { describe, expect, it } from 'vitest';

import { hasRuntimeCredentialConfigured } from '@core/cli/runtime-credential-check.js';

function settingsWithRef(ref: string) {
  return {
    providers: {
      telegram: { defaultConnection: 'telegram_default' },
    },
    providerConnections: {
      telegram_default: {
        runtimeSecretRefs: { bot_token: ref },
      },
    },
  };
}

describe('runtime credential readiness', () => {
  it('requires env-backed runtime secret refs to resolve to a value', () => {
    expect(
      hasRuntimeCredentialConfigured({
        settings: settingsWithRef('env:TELEGRAM_BOT_TOKEN'),
        env: {},
        providerId: 'telegram',
        envKey: 'TELEGRAM_BOT_TOKEN',
      }),
    ).toBe(false);

    expect(
      hasRuntimeCredentialConfigured({
        settings: settingsWithRef('env:TELEGRAM_BOT_TOKEN'),
        env: { TELEGRAM_BOT_TOKEN: 'token' },
        providerId: 'telegram',
        envKey: 'TELEGRAM_BOT_TOKEN',
      }),
    ).toBe(true);
  });

  it('treats stored runtime secret refs as configured by reference', () => {
    expect(
      hasRuntimeCredentialConfigured({
        settings: settingsWithRef('gantry-secret:TELEGRAM_BOT_TOKEN'),
        env: {},
        providerId: 'telegram',
        envKey: 'TELEGRAM_BOT_TOKEN',
      }),
    ).toBe(true);
  });

  it('treats unresolved stored runtime secret refs as missing', () => {
    expect(
      hasRuntimeCredentialConfigured({
        settings: settingsWithRef('gantry-secret:TELEGRAM_BOT_TOKEN'),
        env: {},
        providerId: 'telegram',
        envKey: 'TELEGRAM_BOT_TOKEN',
        unresolvedRuntimeSecretProviderIds: new Set(['telegram']),
      }),
    ).toBe(false);
  });
});
