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
    expect(resolveRuntimeHome('~/gantry')).toBe(
      path.resolve('/tmp/test-home/gantry'),
    );
  });

  it('preserves non-home-tilde patterns', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/tmp/test-home');
    expect(resolveRuntimeHome('~other-user/gantry')).toBe(
      path.resolve('~other-user/gantry'),
    );
  });

  it('uses ~/gantry as the canonical default runtime home', () => {
    expect(path.basename(DEFAULT_RUNTIME_HOME)).toBe('gantry');
  });
});
