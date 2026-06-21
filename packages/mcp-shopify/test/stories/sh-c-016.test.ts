import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { emptyProductByHandle, graphqlOk } from '../fixtures/responses.js';
import { ProductCatalogCache } from '../../src/tools/product-catalog-cache.js';

describe('SH-C-016 out of stock / discontinued product', () => {
  it('detects the product is missing and finds alternatives', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(emptyProductByHandle())],
    });
    const productCatalogCache = new ProductCatalogCache();
    productCatalogCache.replace([
      {
        handle: 'kaju-classic',
        title: 'Kaju Classic',
        tags: ['gift-box'],
        priceMin: '650.00',
        priceMax: '650.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/kaju-classic',
      },
      {
        handle: 'kaju-mini',
        title: 'Kaju Mini',
        tags: ['gift-box'],
        priceMin: '450.00',
        priceMax: '450.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/kaju-mini',
      },
    ]);
    const harness = buildToolHarness(mock.fetch, { productCatalogCache });
    const missing = await harness.call<{ product: unknown }>('get_product', {
      handleOrId: 'mango-barfi-gift-box',
    });
    expect(missing.data?.product).toBeNull();
    const alts = await harness.call<{
      products: Array<{ title: string }>;
    }>('search_products', { tag: 'gift-box' });
    expect(alts.data?.products.map((p) => p.title)).toEqual([
      'Kaju Classic',
      'Kaju Mini',
    ]);
    expect(mock.graphqlCallCount()).toBe(1);
    harness.tokenManager.stop();
  });
});
