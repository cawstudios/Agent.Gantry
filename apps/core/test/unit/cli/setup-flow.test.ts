import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { restoreDraft } from '@core/cli/setup-flow.js';

const tempRoots: string[] = [];

function makeRuntimeHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-setup-flow-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('setup-flow draft restore', () => {
  it('does not create settings.yaml before setup confirmation', () => {
    const runtimeHome = makeRuntimeHome();
    const settingsPath = path.join(runtimeHome, 'settings.yaml');

    const draft = restoreDraft(runtimeHome, null);

    expect(draft.runtimeHome).toBe(runtimeHome);
    expect(draft.postgresSchema).toBe('myclaw');
    expect(fs.existsSync(settingsPath)).toBe(false);
  });
});