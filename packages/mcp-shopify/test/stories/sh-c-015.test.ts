import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { ProductCatalogCache } from '../../src/tools/product-catalog-cache.js';

describe("SH-C-015 'what's available for Diwali?'", () => {
  it('returns active products tagged with diwali', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const productCatalogCache = new ProductCatalogCache();
    productCatalogCache.replace([
      {
        handle: 'diwali-hamper-classic',
        title: 'Diwali Classic Hamper',
        tags: ['diwali'],
        priceMin: '1500.00',
        priceMax: '1500.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/diwali-hamper-classic',
      },
      {
        handle: 'diwali-mini',
        title: 'Diwali Mini',
        tags: ['diwali'],
        priceMin: '750.00',
        priceMax: '750.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/diwali-mini',
      },
    ]);
    const harness = buildToolHarness(mock.fetch, { productCatalogCache });
    const result = await harness.call<{
      products: Array<{ title: string; url: string }>;
    }>('search_products', { tag: 'diwali' });
    expect(result.data?.products.map((p) => p.title)).toEqual([
      'Diwali Classic Hamper',
      'Diwali Mini',
    ]);
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });
});
