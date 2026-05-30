import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, productsEdges } from '../fixtures/responses.js';

describe('SH-C-017 gift recommendation in a price band', () => {
  it('filters by price band 500-800', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            { handle: 'gift-1', title: 'Gift 1', tags: ['gift'], minPrice: '450.00', maxPrice: '450.00' },
            { handle: 'gift-2', title: 'Gift 2', tags: ['gift'], minPrice: '650.00', maxPrice: '650.00' },
            { handle: 'gift-3', title: 'Gift 3', tags: ['gift'], minPrice: '780.00', maxPrice: '780.00' },
            { handle: 'gift-4', title: 'Gift 4', tags: ['gift'], minPrice: '900.00', maxPrice: '900.00' },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      products: Array<{ handle: string }>;
    }>('search_products', { tag: 'gift', priceMin: 500, priceMax: 800 });
    const handles = (result.data?.products ?? []).map((p) => p.handle);
    expect(handles).toEqual(['gift-2', 'gift-3']);
    harness.tokenManager.stop();
  });
});
