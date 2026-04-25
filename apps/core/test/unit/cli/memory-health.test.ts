import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { inspectMemoryHealth } from '@core/cli/memory-health.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import {
  type EmbeddingProvider,
  registerEmbeddingProvider,
} from '@core/memory/memory-embeddings.js';

function runtimeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-health-'));
}

describe('memory health', () => {
  it('uses the embedding provider registry for custom providers', () => {
    const providerName = `custom-provider-${Date.now()}`;
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
    const settings = createDefaultRuntimeSettings();
    settings.memory.embeddings.enabled = true;
    settings.memory.embeddings.provider = providerName;
    settings.memory.embeddings.model = 'custom-embedding-model';

    const health = inspectMemoryHealth(runtimeHome(), settings, {});

    expect(health.embeddingCheck.status).toBe('pass');
    expect(health.embeddingCheck.message).toContain(providerName);
  });

  it('fails unknown embedding providers before runtime use', () => {
    const settings = createDefaultRuntimeSettings();
    settings.memory.embeddings.enabled = true;
    settings.memory.embeddings.provider = 'not-registered';
    settings.memory.embeddings.model = 'custom-embedding-model';

    const health = inspectMemoryHealth(runtimeHome(), settings, {});

    expect(health.embeddingCheck.status).toBe('fail');
    expect(health.embeddingCheck.message).toContain(
      'Unknown embedding provider',
    );
  });
});
