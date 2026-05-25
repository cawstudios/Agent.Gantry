import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedMemorySubject } from '@core/memory/memory-types.js';

const memoryLlmQuery = vi.fn();

vi.mock('@core/config/index.js', () => ({
  getMemoryModelRuntimeConfig: () => ({
    extractor: 'claude-haiku-test',
    dreaming: 'claude-sonnet-dreaming-test',
    consolidation: 'claude-sonnet-consolidation-test',
  }),
}));

vi.mock('@core/memory/memory-llm-port.js', () => ({
  getMemoryLlmClient: () => ({
    isConfigured: () => true,
    query: memoryLlmQuery,
  }),
}));

const subject: NormalizedMemorySubject = {
  appId: 'app-a',
  agentId: 'agent-a',
  groupId: 'group-a',
  subjectType: 'group',
  subjectId: 'group-a',
};

describe('memory LLM proposal model selection', () => {
  beforeEach(() => {
    memoryLlmQuery.mockReset();
    memoryLlmQuery.mockResolvedValue('[]');
  });

  it('uses the configured dreaming model for dreaming proposals', async () => {
    const { proposeMemoryDreamingActions } =
      await import('@core/memory/memory-llm-proposals.js');
    const controller = new AbortController();

    await proposeMemoryDreamingActions({
      subject,
      evidence: [],
      candidates: [],
      activeItems: [],
      signal: controller.signal,
      timeoutMs: 42_000,
    });

    expect(memoryLlmQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-dreaming-test',
        signal: controller.signal,
        timeoutMs: 42_000,
      }),
    );
  });

  it('uses the configured consolidation model for consolidation proposals', async () => {
    const { proposeMemoryConsolidationActions } =
      await import('@core/memory/memory-llm-proposals.js');
    const controller = new AbortController();

    await proposeMemoryConsolidationActions({
      subject,
      activeItems: [],
      signal: controller.signal,
      timeoutMs: 84_000,
    });

    expect(memoryLlmQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-consolidation-test',
        signal: controller.signal,
        timeoutMs: 84_000,
      }),
    );
  });

  it('rethrows aborted dreaming proposal calls instead of swallowing them', async () => {
    const { proposeMemoryDreamingActions } =
      await import('@core/memory/memory-llm-proposals.js');
    const controller = new AbortController();
    const deadline = new Error(
      'memory dreaming deadline exceeded after 5000ms',
    );
    memoryLlmQuery.mockImplementation(
      async (input: { signal?: AbortSignal }) => {
        expect(input.signal).toBe(controller.signal);
        controller.abort(deadline);
        throw deadline;
      },
    );

    await expect(
      proposeMemoryDreamingActions({
        subject,
        evidence: [],
        candidates: [],
        activeItems: [],
        signal: controller.signal,
      }),
    ).rejects.toThrow('memory dreaming deadline exceeded after 5000ms');
  });
});
