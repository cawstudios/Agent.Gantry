// NOTE: filename is legacy (the sync moved from registerGroup to a boot pass);
// rename to authored-prompt-boot-sync.test.ts when `git mv` is available.
import fs from 'fs';
import path from 'path';

import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import { FileArtifactNotFoundError } from '@core/domain/file-artifacts/file-artifact.js';

// Deterministic temp AGENTS_DIR path (computed hoisted, above imports; the
// directory is created in beforeAll).
const tmpRoot = vi.hoisted(() => {
  const base = process.env.TMPDIR || '/tmp';
  return `${base.replace(/\/$/, '')}/gantry-boot-sync-test-${process.pid}`;
});

vi.mock('@core/config/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@core/config/index.js')>();
  return { ...actual, AGENTS_DIR: tmpRoot };
});

import { syncAuthoredPromptsAtBoot } from '@core/runtime/authored-prompt-boot-sync.js';
import { EmptyAuthoredPromptFileError } from '@core/application/agents/authored-prompt-sync.js';

beforeAll(() => fs.mkdirSync(tmpRoot, { recursive: true }));

function writeAgentFiles(folder: string, soul: string, claude: string) {
  const dir = path.join(tmpRoot, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SOUL.md'), soul);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claude);
}

function recordingStore() {
  const writes: Array<{ virtualPath: string; content: string }> = [];
  return {
    writes,
    async writeFileArtifact(input: {
      virtualPath: string;
      content: string | Uint8Array;
    }) {
      writes.push({
        virtualPath: input.virtualPath,
        content:
          typeof input.content === 'string'
            ? input.content
            : Buffer.from(input.content).toString('utf-8'),
      });
      return { version: writes.length } as never;
    },
    async readFileArtifact() {
      throw new FileArtifactNotFoundError();
    },
    async listFileArtifacts() {
      return [] as never;
    },
    async promoteScratch() {
      throw new Error('unused');
    },
  };
}

const logger = { info: vi.fn(), warn: vi.fn() };
afterEach(() => vi.clearAllMocks());

it('syncs authored files for each configured agent at boot', async () => {
  writeAgentFiles('boondi', '# Soul\nBe sharp.', '# Claude\nUse tools.');
  const store = recordingStore();

  await syncAuthoredPromptsAtBoot({
    agents: { boondi: { name: 'Boondi' } },
    getFileArtifactStore: () => store as never,
    logger,
  });

  expect(store.writes.map((w) => w.virtualPath).sort()).toEqual([
    'boondi/CLAUDE.md',
    'boondi/SOUL.md',
  ]);
});

it('aborts startup when an authored file is empty', async () => {
  writeAgentFiles('boondi', '   \n', 'group rules');
  const store = recordingStore();

  await expect(
    syncAuthoredPromptsAtBoot({
      agents: { boondi: { name: 'Boondi' } },
      getFileArtifactStore: () => store as never,
      logger,
    }),
  ).rejects.toBeInstanceOf(EmptyAuthoredPromptFileError);
  expect(store.writes).toHaveLength(0);
});

it('skips invalid agent folder names without throwing', async () => {
  const store = recordingStore();

  await syncAuthoredPromptsAtBoot({
    agents: { '../../etc': { name: 'evil' } },
    getFileArtifactStore: () => store as never,
    logger,
  });

  expect(store.writes).toHaveLength(0);
  expect(logger.warn).toHaveBeenCalled();
});
