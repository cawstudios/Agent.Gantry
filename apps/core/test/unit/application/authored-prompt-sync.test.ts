import { expect, it, vi } from 'vitest';

import {
  syncAuthoredPromptFiles,
  EmptyAuthoredPromptFileError,
  type AuthoredFileReader,
} from '@core/application/agents/authored-prompt-sync.js';

function fakeService() {
  return {
    syncAuthoredArtifact: vi.fn(async () => ({ changed: true, version: 1 })),
    ensureAgentDefaults: vi.fn(async () => {}),
  };
}

const base = {
  agentFolder: 'team',
  agentName: 'Kai',
  appId: 'default',
  agentId: 'agent:team',
};

it('syncs both files when present and non-empty', async () => {
  const service = fakeService();
  const read: AuthoredFileReader = (name) => ({ exists: true, content: `# ${name}` });

  const results = await syncAuthoredPromptFiles({ ...base, service: service as never, read });

  expect(service.syncAuthoredArtifact).toHaveBeenCalledTimes(2);
  expect(service.ensureAgentDefaults).not.toHaveBeenCalled();
  expect(results.map((r) => r.virtualPath)).toEqual(['team/SOUL.md', 'team/CLAUDE.md']);
});

it('throws and writes nothing when a file is present but empty', async () => {
  const service = fakeService();
  const read: AuthoredFileReader = (name) =>
    name === 'SOUL.md' ? { exists: true, content: '   \n\t' } : { exists: true, content: 'x' };

  await expect(
    syncAuthoredPromptFiles({ ...base, service: service as never, read }),
  ).rejects.toBeInstanceOf(EmptyAuthoredPromptFileError);
  expect(service.syncAuthoredArtifact).not.toHaveBeenCalled();
});

it('throws and writes nothing even when the valid file is read before the empty one', async () => {
  const service = fakeService();
  // SOUL.md valid, CLAUDE.md empty — the empty file is SECOND in the scan order.
  // Pre-validation must fail-loud BEFORE writing the valid SOUL.md, so fail-loud
  // stays all-or-nothing (no half-written prompt store).
  const read: AuthoredFileReader = (name) =>
    name === 'SOUL.md'
      ? { exists: true, content: '# Soul' }
      : { exists: true, content: '   ' };

  await expect(
    syncAuthoredPromptFiles({ ...base, service: service as never, read }),
  ).rejects.toBeInstanceOf(EmptyAuthoredPromptFileError);
  expect(service.syncAuthoredArtifact).not.toHaveBeenCalled();
});

it('falls back to generic defaults when a file is absent', async () => {
  const service = fakeService();
  const read: AuthoredFileReader = (name) =>
    name === 'SOUL.md' ? { exists: true, content: '# Soul' } : { exists: false, content: '' };

  await syncAuthoredPromptFiles({ ...base, service: service as never, read });

  expect(service.syncAuthoredArtifact).toHaveBeenCalledTimes(1);
  expect(service.ensureAgentDefaults).toHaveBeenCalledWith({
    agentFolder: 'team',
    agentName: 'Kai',
  });
});
