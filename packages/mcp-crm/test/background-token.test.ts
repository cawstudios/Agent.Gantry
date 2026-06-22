import { describe, expect, it } from 'vitest';

import {
  BACKGROUND_TOKEN_ENV,
  resolveBackgroundToken,
} from '../src/background-token.js';

describe('resolveBackgroundToken (token seam)', () => {
  it('uses the dedicated background token when set (trimmed)', () => {
    expect(
      resolveBackgroundToken({
        [BACKGROUND_TOKEN_ENV]: '  sk-bg-123  ',
      } as NodeJS.ProcessEnv),
    ).toEqual({ source: 'background_env', token: 'sk-bg-123' });
  });

  it('falls back to the gantry credential center when unset (same token in dev)', () => {
    expect(resolveBackgroundToken({} as NodeJS.ProcessEnv)).toEqual({
      source: 'gantry_credential_center',
    });
  });

  it('treats an empty/whitespace token as unset', () => {
    expect(
      resolveBackgroundToken({
        [BACKGROUND_TOKEN_ENV]: '   ',
      } as NodeJS.ProcessEnv),
    ).toEqual({ source: 'gantry_credential_center' });
  });
});
