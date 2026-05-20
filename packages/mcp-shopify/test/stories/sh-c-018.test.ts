import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { discountNodes, graphqlOk } from '../fixtures/responses.js';

describe('SH-C-018 discount code not working', () => {
  it('active code with minimum order met', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          discountNodes([
            { title: 'BSSDIWALI20', minimumOrderAmount: '1000.00' },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      exists: boolean;
      active: boolean;
      meetsMinimum?: boolean;
    }>('validate_discount_code', { code: 'BSSDIWALI20', cartTotal: 1200 });
    expect(result.data?.exists).toBe(true);
    expect(result.data?.active).toBe(true);
    expect(result.data?.meetsMinimum).toBe(true);
    harness.tokenManager.stop();
  });

  it('expired code surfaces reason', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(discountNodes([{ title: 'OLDONE', status: 'EXPIRED' }])),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      exists: boolean;
      active: boolean;
      reason?: string;
    }>('validate_discount_code', { code: 'OLDONE' });
    expect(result.data?.active).toBe(false);
    expect(result.data?.reason).toBe('expired');
    harness.tokenManager.stop();
  });

  it('unknown code returns exists=false', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk({ codeDiscountNodes: { edges: [] } })],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{ exists: boolean }>(
      'validate_discount_code',
      { code: 'GIBBERISH' },
    );
    expect(result.data?.exists).toBe(false);
    harness.tokenManager.stop();
  });
});
