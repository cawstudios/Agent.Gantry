import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import type { EmbeddingProvider } from '@core/memory/memory-embeddings.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-'));
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

async function loadMemoryCommand() {
  const log = {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    note: vi.fn(),
    log,
  }));
  const { runMemoryCommand } = await import('@core/cli/memory.js');
  return { runMemoryCommand, log };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('memory command', () => {
  it('does not save a provider that is registered but not configured', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runMemoryCommand, log } = await loadMemoryCommand();

    const code = await runMemoryCommand(runtimeHome, ['embeddings', 'openai']);

    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Embedding provider "openai" is not ready'),
    );
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.memory.embeddings.enabled).toBe(false);
    expect(settings.memory.embeddings.provider).toBe('disabled');
  });

  it('enables registered providers that validate successfully', async () => {
    const runtimeHome = makeRuntimeHome();
    const providerName = `ready-provider-${Date.now()}`;
    const { registerEmbeddingProvider } =
      await import('@core/memory/memory-embeddings.js');
    registerEmbeddingProvider(
      providerName,
      () =>
        ({
          isEnabled: () => true,
          validateConfiguration: () => undefined,
          embedMany: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
          embedOne: async () => [0.1, 0.2],
        }) satisfies EmbeddingProvider,
    );
    saveRuntimeSettings(runtimeHome, loadRuntimeSettings(runtimeHome));
    const { runMemoryCommand, log } = await loadMemoryCommand();

    const code = await runMemoryCommand(runtimeHome, [
      'embeddings',
      providerName,
    ]);

    expect(code).toBe(0);
    expect(log.success).toHaveBeenCalledWith(
      `Memory embeddings set to ${providerName} in settings.yaml.`,
    );
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.memory.embeddings.enabled).toBe(true);
    expect(settings.memory.embeddings.provider).toBe(providerName);
  });
});
