import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RUNTIME_HOME,
  resolveRuntimeHome,
} from '@core/config/settings/runtime-home.js';

describe('resolveRuntimeHome', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('expands "~" to the current user home', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/tmp/test-home');
    expect(resolveRuntimeHome('~')).toBe(path.resolve('/tmp/test-home'));
  });

  it('expands "~/" prefixes to a path under home', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/tmp/test-home');
    expect(resolveRuntimeHome('~/myclaw')).toBe(
      path.resolve('/tmp/test-home/myclaw'),
    );
  });

  it('preserves non-home-tilde patterns', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/tmp/test-home');
    expect(resolveRuntimeHome('~other-user/myclaw')).toBe(
      path.resolve('~other-user/myclaw'),
    );
  });

  it('uses ~/myclaw as the canonical default runtime home', () => {
    expect(path.basename(DEFAULT_RUNTIME_HOME)).toBe('myclaw');
  });
});
