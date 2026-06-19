import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadAgentPreRunContextProvider } from '@core/application/pre-run-context/pre-run-context-registry.js';

const tmpRoot = path.join(
  process.env.TMPDIR || '/tmp',
  `gantry-pre-run-context-registry-${process.pid}`,
);

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadAgentPreRunContextProvider', () => {
  it('loads a valid named provider from an agent folder', async () => {
    const dir = path.join(tmpRoot, 'boondi_support', 'pre-run-context');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'returning-customer-crm.js'),
      [
        'export const provider = {',
        "  name: 'returning-customer-crm',",
        "  build: async () => '<ctx />',",
        '};',
      ].join('\n'),
    );

    const provider = await loadAgentPreRunContextProvider({
      agentFolderPath: path.join(tmpRoot, 'boondi_support'),
      name: 'returning-customer-crm',
    });

    expect(provider?.name).toBe('returning-customer-crm');
    await expect(provider?.build({} as never)).resolves.toBe('<ctx />');
  });

  it('rejects path traversal provider names', async () => {
    const provider = await loadAgentPreRunContextProvider({
      agentFolderPath: path.join(tmpRoot, 'boondi_support'),
      name: '../returning-customer-crm',
    });

    expect(provider).toBeNull();
  });
});
