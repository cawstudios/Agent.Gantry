import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import {
  emptyProductByHandle,
  graphqlOk,
  productsEdges,
} from '../fixtures/responses.js';

describe('SH-C-016 out of stock / discontinued product', () => {
  it('detects the product is missing and finds alternatives', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(emptyProductByHandle()),
        graphqlOk(
          productsEdges([
            { handle: 'kaju-classic', title: 'Kaju Classic', tags: ['gift-box'], totalInventory: 30 },
            { handle: 'kaju-mini', title: 'Kaju Mini', tags: ['gift-box'], totalInventory: 12 },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const missing = await harness.call<{ product: unknown }>('get_product', {
      handleOrId: 'mango-barfi-gift-box',
    });
    expect(missing.data?.product).toBeNull();
    const alts = await harness.call<{
      products: Array<{ available: boolean }>;
    }>('search_products', { tag: 'gift-box' });
    expect((alts.data?.products ?? []).every((p) => p.available)).toBe(true);
    harness.tokenManager.stop();
  });
});
