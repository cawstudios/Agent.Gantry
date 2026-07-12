import { describe, expect, it } from 'vitest';

import { stripRuntimeEnvPrefix } from '@core/shared/runtime-env-command.js';

describe('stripRuntimeEnvPrefix', () => {
  it('strips the recognized runtime environment prefix', () => {
    expect(
      stripRuntimeEnvPrefix(
        "GODEBUG='http2client=0' HTTP_PROXY=http://127.0.0.1:8080 HTTPS_PROXY=http://127.0.0.1:8080 NO_PROXY=localhost NODE_USE_ENV_PROXY=1 gog auth --help",
      ),
    ).toEqual({
      command: 'gog auth --help',
      envAssignments: [
        "GODEBUG='http2client=0'",
        'HTTP_PROXY=http://127.0.0.1:8080',
        'HTTPS_PROXY=http://127.0.0.1:8080',
        'NO_PROXY=localhost',
        'NODE_USE_ENV_PROXY=1',
      ],
    });
  });

  it('leaves commands without a recognized runtime prefix unchanged', () => {
    expect(stripRuntimeEnvPrefix('gog auth list')).toEqual({
      command: 'gog auth list',
      envAssignments: [],
    });
  });
});
