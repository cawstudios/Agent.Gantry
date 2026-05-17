import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = process.argv;
const originalHome = process.env.GANTRY_HOME;

afterEach(() => {
  process.argv = originalArgv;
  if (originalHome === undefined) {
    delete process.env.GANTRY_HOME;
  } else {
    process.env.GANTRY_HOME = originalHome;
  }
  vi.resetModules();
});

describe('runtime-home env bootstrap', () => {
  it('sets GANTRY_HOME before config-sensitive CLI imports run', async () => {
    delete process.env.GANTRY_HOME;
    process.argv = ['node', 'gantry', '--runtime-home', './tmp-runtime'];

    await import('@core/cli/runtime-home-env-bootstrap.js');

    expect(process.env.GANTRY_HOME).toBe(path.resolve('./tmp-runtime'));
  });

  it('supports --runtime-home=value', async () => {
    delete process.env.GANTRY_HOME;
    process.argv = ['node', 'gantry', '--runtime-home=./another-runtime'];

    await import('@core/cli/runtime-home-env-bootstrap.js');

    expect(process.env.GANTRY_HOME).toBe(path.resolve('./another-runtime'));
  });
});
