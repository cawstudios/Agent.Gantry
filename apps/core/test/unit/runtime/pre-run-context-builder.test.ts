import { describe, expect, it, vi } from 'vitest';

import { buildPreRunContextBlock } from '@core/runtime/pre-run-context-builder.js';

describe('buildPreRunContextBlock', () => {
  it('joins non-empty provider blocks and soft-fails provider errors', async () => {
    const warn = vi.fn();

    const block = await buildPreRunContextBlock({
      providerNames: ['ok', 'bad'],
      loadProvider: async (name) =>
        name === 'ok'
          ? { name, build: async () => '<ctx>ok</ctx>' }
          : {
              name,
              build: async () => {
                throw new Error('boom');
              },
            },
      input: {
        agentFolder: 'boondi_support',
        conversationJid: 'wa:000299180577',
        hasRecentSessionDigest: true,
        callMcpTool: vi.fn(),
        log: { info: vi.fn(), warn },
      },
    });

    expect(block).toBe('<ctx>ok</ctx>');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'bad', err: 'boom' }),
      'pre_run_context_provider_failed',
    );
  });

  it('returns empty string when no providers are configured', async () => {
    const block = await buildPreRunContextBlock({
      providerNames: undefined,
      loadProvider: vi.fn(),
      input: {
        agentFolder: 'boondi_support',
        conversationJid: 'wa:000299180577',
        hasRecentSessionDigest: false,
        callMcpTool: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn() },
      },
    });

    expect(block).toBe('');
  });
});
