import { describe, expect, it } from 'vitest';

import {
  requestCallerResolvedTool,
  settleCallerResolvedTool,
} from '@core/application/interactions/caller-resolved-tool-coordinator.js';

describe('caller-resolved tool coordinator', () => {
  it('resumes the same tool wait and deduplicates settlement', async () => {
    let required!: () => void;
    const emitted = new Promise<void>((resolve) => {
      required = resolve;
    });
    const controller = new AbortController();
    const result = requestCallerResolvedTool({
      appId: 'app',
      runId: 'run-1',
      sourceAgentFolder: 'agent-folder',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      toolName: 'opaque_tool',
      toolInput: { query: 'value' },
      timeoutMs: 5_000,
      signal: controller.signal,
      emitRequired: async () => required(),
    });
    await emitted;
    await expect(
      settleCallerResolvedTool({
        appId: 'app',
        sessionId: 'session-1',
        interactionId: 'interaction-1',
        idempotencyKey: 'delivery-1',
        resolution: { status: 'resolved', result: { answer: 42 } },
      }),
    ).resolves.toBe('resolved');
    await expect(result).resolves.toEqual({ answer: 42 });
    await expect(
      settleCallerResolvedTool({
        appId: 'app',
        sessionId: 'session-1',
        interactionId: 'interaction-1',
        idempotencyKey: 'delivery-1',
        resolution: { status: 'resolved', result: { answer: 42 } },
      }),
    ).resolves.toBe('idempotent');
  });
});
