import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const groups = vi.hoisted(() => new Map<string, any>());
const requests = vi.hoisted(() => [] as Array<{ path: string; body?: any }>);

vi.mock('@core/cli/runtime-group-db.js', () => ({
  openRuntimeGroupDb: async () => ({
    getAllConversationRoutes: async () => Object.fromEntries(groups.entries()),
    close: async () => undefined,
  }),
}));

vi.mock('@core/cli/control-api.js', () => ({
  controlApiRequest: async (_runtimeHome: string, input: any) => {
    requests.push({ path: input.path, body: input.body });
    return { content: '# exported' };
  },
}));

import { runProfile } from '@core/cli/agent-profile.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-profile-cli-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  groups.clear();
  requests.length = 0;
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('agent profile CLI', () => {
  it('returns a handled failure for unknown selectors', async () => {
    await expect(
      runProfile(makeRuntimeHome(), ['list', 'tg:missing']),
    ).resolves.toBe(1);

    expect(requests).toHaveLength(0);
  });

  it('resolves JID selectors to the bound agent before calling control API', async () => {
    groups.set('tg:123', {
      name: 'Main',
      folder: 'main_agent',
      trigger: '@main',
      added_at: '2026-06-03T00:00:00.000Z',
    });

    await expect(
      runProfile(makeRuntimeHome(), ['list', 'tg:123']),
    ).resolves.toBe(0);

    expect(requests[0]?.path).toBe(
      '/v1/agents/agent%3Amain_agent/profile-files',
    );
  });

  it('exports AGENTS profile content to a non-reserved mirror filename', async () => {
    const runtimeHome = makeRuntimeHome();
    groups.set('tg:123', {
      name: 'Main',
      folder: 'main_agent',
      trigger: '@main',
      added_at: '2026-06-03T00:00:00.000Z',
    });

    await expect(
      runProfile(runtimeHome, ['export', 'tg:123', 'agents']),
    ).resolves.toBe(0);

    expect(
      fs.existsSync(
        path.join(runtimeHome, 'agents', 'main_agent', 'AGENTS.md'),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(runtimeHome, 'agents', 'main_agent', 'AGENTS.profile.md'),
        'utf-8',
      ),
    ).toContain('# exported');
  });
});
