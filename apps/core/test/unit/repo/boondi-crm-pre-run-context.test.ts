import { describe, expect, it, vi } from 'vitest';

import { provider } from '../../../../../agents/boondi_support/pre-run-context/returning-customer-crm.ts';

describe('Boondi returning-customer CRM pre-run context provider', () => {
  it('skips CRM when no recent digest exists', async () => {
    const callMcpTool = vi.fn();

    const result = await provider.build({
      agentFolder: 'boondi_support',
      conversationJid: 'wa:000299180577',
      hasRecentSessionDigest: false,
      callMcpTool,
      log: { info: vi.fn(), warn: vi.fn() },
    } as never);

    expect(result).toBeNull();
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('returns compact verified CRM context when latest query or lead exists', async () => {
    const result = await provider.build({
      agentFolder: 'boondi_support',
      conversationJid: 'wa:000299180577',
      hasRecentSessionDigest: true,
      callMcpTool: vi.fn(async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              found: true,
              record: {
                id: 'bcr_1',
                status: 'query',
                intentCategory: 'gifting_personal',
                summaryBrief: '10-12 birthday boxes around Rs 500 each',
                quantityRaw: '10-12 boxes',
                budgetRaw: 'around 500 each',
                score: 91,
                band: 'P1',
                updatedAt: '2026-06-19T10:00:00.000Z',
              },
            }),
          },
        ],
      })),
      log: { info: vi.fn(), warn: vi.fn() },
    } as never);

    expect(result).toContain('<boondi_crm_context');
    expect(result).toContain('"latestQueryOrLead"');
    expect(result).toContain('10-12 birthday boxes');
    expect(result).not.toContain('score');
    expect(result).not.toContain('band');
  });

  it('soft-fails CRM errors', async () => {
    const warn = vi.fn();

    const result = await provider.build({
      agentFolder: 'boondi_support',
      conversationJid: 'wa:000299180577',
      hasRecentSessionDigest: true,
      callMcpTool: vi.fn(async () => {
        throw new Error('crm unavailable');
      }),
      log: { info: vi.fn(), warn },
    } as never);

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'crm unavailable' }),
      'boondi_crm_prefetch_failed',
    );
  });
});
