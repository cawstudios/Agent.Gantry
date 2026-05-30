import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, productsEdges } from '../fixtures/responses.js';

describe("SH-C-015 'what's available for Diwali?'", () => {
  it('returns active products tagged with diwali', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            { handle: 'diwali-hamper-classic', title: 'Diwali Classic Hamper', tags: ['diwali'], totalInventory: 50 },
            { handle: 'diwali-mini', title: 'Diwali Mini', tags: ['diwali'], totalInventory: 30 },
            { handle: 'diwali-premium', title: 'Diwali Premium', tags: ['diwali'], totalInventory: 8 },
            { handle: 'diwali-corp', title: 'Diwali Corporate', tags: ['diwali'], totalInventory: 100 },
            { handle: 'diwali-family', title: 'Diwali Family Pack', tags: ['diwali'], totalInventory: 20 },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      products: Array<{ handle: string; available: boolean }>;
    }>('search_products', { tag: 'diwali' });
    expect((result.data?.products ?? []).filter((p) => p.available).length).toBeGreaterThanOrEqual(
      1,
    );
    harness.tokenManager.stop();
  });
});
