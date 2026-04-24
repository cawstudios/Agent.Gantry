import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

function runPaths(env: Record<string, string | undefined>): string {
  const scriptPath = path.resolve(process.cwd(), 'ops', 'postgres', 'local.sh');
  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...process.env,
    ...env,
  })) {
    if (typeof value === 'string') {
      mergedEnv[key] = value;
    }
  }
  return execFileSync('bash', [scriptPath, 'paths'], {
    env: mergedEnv,
    encoding: 'utf-8',
  }).trim();
}

describe('ops/postgres/local.sh paths', () => {
  it('defaults to $HOME/myclaw/postgres when MYCLAW_HOME is unset', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-home-'));
    const output = runPaths({
      HOME: tempHome,
      MYCLAW_HOME: undefined,
    });
    expect(output).toContain(`MYCLAW_HOME_RESOLVED=${tempHome}/myclaw`);
    expect(output).toContain(
      `MYCLAW_POSTGRES_DATA_DIR=${tempHome}/myclaw/postgres`,
    );
  });

  it('uses MYCLAW_HOME when provided', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-home-'));
    const customHome = path.join(tempHome, 'myclaw-custom');
    const output = runPaths({
      HOME: tempHome,
      MYCLAW_HOME: customHome,
    });
    expect(output).toContain(`MYCLAW_HOME_RESOLVED=${customHome}`);
    expect(output).toContain(`MYCLAW_POSTGRES_DATA_DIR=${customHome}/postgres`);
  });
});