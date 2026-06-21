import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { ProductCatalogCache } from '../../src/tools/product-catalog-cache.js';

describe('SH-C-017 gift recommendation in a price band', () => {
  it('filters by price band 500-800', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const productCatalogCache = new ProductCatalogCache();
    productCatalogCache.replace([
      {
        handle: 'gift-1',
        title: 'Gift 1',
        tags: ['gift'],
        priceMin: '450.00',
        priceMax: '450.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/gift-1',
      },
      {
        handle: 'gift-2',
        title: 'Gift 2',
        tags: ['gift'],
        priceMin: '650.00',
        priceMax: '650.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/gift-2',
      },
      {
        handle: 'gift-3',
        title: 'Gift 3',
        tags: ['gift'],
        priceMin: '780.00',
        priceMax: '780.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/gift-3',
      },
      {
        handle: 'gift-4',
        title: 'Gift 4',
        tags: ['gift'],
        priceMin: '900.00',
        priceMax: '900.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/gift-4',
      },
    ]);
    const harness = buildToolHarness(mock.fetch, { productCatalogCache });
    const result = await harness.call<{
      products: Array<{ title: string }>;
    }>('search_products', { tag: 'gift', priceMin: 500, priceMax: 800 });
    expect((result.data?.products ?? []).map((p) => p.title)).toEqual([
      'Gift 2',
      'Gift 3',
    ]);
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });
});
