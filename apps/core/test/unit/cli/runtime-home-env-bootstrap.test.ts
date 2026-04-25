import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = process.argv;
const originalHome = process.env.MYCLAW_HOME;

afterEach(() => {
  process.argv = originalArgv;
  if (originalHome === undefined) {
    delete process.env.MYCLAW_HOME;
  } else {
    process.env.MYCLAW_HOME = originalHome;
  }
  vi.resetModules();
});

describe('runtime-home env bootstrap', () => {
  it('sets MYCLAW_HOME before config-sensitive CLI imports run', async () => {
    delete process.env.MYCLAW_HOME;
    process.argv = ['node', 'myclaw', '--runtime-home', './tmp-runtime'];

    await import('@core/cli/runtime-home-env-bootstrap.js');

    expect(process.env.MYCLAW_HOME).toBe(path.resolve('./tmp-runtime'));
  });

  it('supports --runtime-home=value', async () => {
    delete process.env.MYCLAW_HOME;
    process.argv = ['node', 'myclaw', '--runtime-home=./another-runtime'];

    await import('@core/cli/runtime-home-env-bootstrap.js');

    expect(process.env.MYCLAW_HOME).toBe(path.resolve('./another-runtime'));
  });
});
