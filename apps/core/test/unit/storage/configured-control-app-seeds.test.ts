import { describe, expect, it } from 'vitest';

import { configuredControlAppIds } from '@core/adapters/storage/postgres/seeds.js';

describe('configured control application seeds', () => {
  it('returns each valid non-default control app once', () => {
    expect(
      configuredControlAppIds(
        JSON.stringify([
          {
            kid: 'execution',
            token: 'execution-token',
            appId: 'manipal-tender-copilot',
            scopes: ['sessions:write'],
          },
          {
            kid: 'admin',
            token: 'admin-token',
            appId: 'manipal-tender-copilot',
            scopes: ['credentials:admin'],
          },
          {
            kid: 'local',
            token: 'local-token',
            appId: 'default',
            scopes: ['sessions:write'],
          },
        ]),
      ),
    ).toEqual(['manipal-tender-copilot']);
  });

  it('ignores invalid control-key configuration', () => {
    expect(configuredControlAppIds('{')).toEqual([]);
    expect(
      configuredControlAppIds(
        JSON.stringify([
          {
            kid: 'invalid-app',
            token: 'token',
            appId: 'invalid app id',
            scopes: ['sessions:write'],
          },
        ]),
      ),
    ).toEqual([]);
  });
});
