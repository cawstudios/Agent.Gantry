import { describe, expect, it } from 'vitest';
import { makeFakeRepo } from './helpers/fakes.js';
import { applyExtraction } from '../src/extractor/apply.js';
import type { ExtractedOpportunity } from '../src/extractor/types.js';

const opp = (over: Partial<ExtractedOpportunity>): ExtractedOpportunity => ({
  match: null,
  isLead: false,
  summaryBrief: 's',
  evidenceQuote: 'e',
  confidence: 0.9,
  ...over,
});

describe('applyExtraction', () => {
  it('creates one record per new opportunity and maps fields (golden 3-order)', async () => {
    const repo = makeFakeRepo();
    const r = await applyExtraction(repo, {
      phone: '919',
      conversationId: 'conversation:wa:919',
      opportunities: [
        opp({
          occasion: 'Raksha Bandhan',
          quantity: 50,
          isLead: true,
          evidenceQuote: 'order 50',
        }),
        opp({ occasion: 'Quarterly', quantity: 100, isLead: true }),
        opp({ quantity: 10, isLead: false }),
      ],
    });
    expect(r.created).toBe(3);
    expect(r.updated).toBe(0);
    expect(r.records.map((x) => x.action)).toEqual([
      'created',
      'created',
      'created',
    ]);
    expect(repo.upsertOpportunity).toHaveBeenCalledTimes(3);
    const first = repo.upsertOpportunity.mock.calls[0][0];
    expect(first.targetLead).toBe(true); // isLead -> targetLead
    expect(first.input.triggerExcerpt).toBe('order 50'); // evidenceQuote -> triggerExcerpt
    expect(first.input.occasion).toBe('Raksha Bandhan');
    expect(first.match).toBeNull();
    expect(first.source).toBe('extractor');
  });

  it('routes confidence < 0.5 to needsReview', async () => {
    const repo = makeFakeRepo();
    await applyExtraction(repo, {
      phone: '919',
      conversationId: 'c',
      opportunities: [opp({ confidence: 0.3 })],
    });
    expect(repo.upsertOpportunity.mock.calls[0][0].needsReview).toBe(true);
  });

  it('counts updates when an opportunity matches an existing id (idempotency)', async () => {
    const repo = makeFakeRepo();
    const r = await applyExtraction(repo, {
      phone: '919',
      conversationId: 'c',
      opportunities: [opp({ match: 'bcr_x', quantity: 300 })],
    });
    expect(r.updated).toBe(1);
    expect(r.created).toBe(0);
    expect(r.records[0].action).toBe('updated');
    expect(repo.upsertOpportunity.mock.calls[0][0].match).toBe('bcr_x');
  });
});
