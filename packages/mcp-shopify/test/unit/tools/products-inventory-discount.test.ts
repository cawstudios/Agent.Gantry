import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../../helpers/tool-harness.js';
import { buildMockFetch } from '../../helpers/mock-fetch.js';
import {
  discountNodes,
  emptyProductByHandle,
  graphqlOk,
  productByHandle,
  productInventoryByHandle,
  variantInventory,
} from '../../fixtures/responses.js';
import { ProductCatalogCache } from '../../../src/tools/product-catalog-cache.js';

describe('search_products', () => {
  function buildCatalogHarness(
    products: Array<{
      handle: string;
      title: string;
      priceMin: string;
      priceMax?: string;
      currency?: string;
      url?: string;
      tags?: string[];
    }>,
  ) {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const productCatalogCache = new ProductCatalogCache();
    productCatalogCache.replace(
      products.map((product) => ({
        ...product,
        priceMax: product.priceMax ?? product.priceMin,
        currency: product.currency ?? 'INR',
        url:
          product.url ?? `https://shop.example.com/products/${product.handle}`,
      })),
    );
    return {
      mock,
      harness: buildToolHarness(mock.fetch, { productCatalogCache }),
    };
  }

  it('returns lean cached catalog products without a Shopify customer-turn call', async () => {
    const { mock, harness } = buildCatalogHarness([
      {
        handle: 'birthday-fudge',
        title: 'Birthday Fudge Box',
        priceMin: '450.00',
        priceMax: '450.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/birthday-fudge',
      },
    ]);

    const result = await harness.call<{
      products: Array<Record<string, unknown>>;
    }>('search_products', { query: 'birthday gift', priceMax: 500 });

    expect(result.error).toBeUndefined();
    expect(result.data?.products).toEqual([
      {
        title: 'Birthday Fudge Box',
        priceMin: '450.00',
        priceMax: '450.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/birthday-fudge',
      },
    ]);
    expect(result.data?.products[0]).not.toHaveProperty('handle');
    expect(result.data?.products[0]).not.toHaveProperty('id');
    expect(result.data?.products[0]).not.toHaveProperty('available');
    expect(result.data?.products[0]).not.toHaveProperty('priceRange');
    expect(result.raw).not.toHaveProperty('replyContract');
    expect(result.raw).not.toHaveProperty('replyFacts');
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('filters cached catalog products by tag and price band', async () => {
    const { harness } = buildCatalogHarness([
      {
        handle: 'cheap-box',
        title: 'Cheap',
        priceMin: '300.00',
        tags: ['diwali'],
      },
      {
        handle: 'in-band',
        title: 'In band',
        priceMin: '600.00',
        priceMax: '700.00',
        tags: ['diwali'],
      },
      {
        handle: 'wrong-tag',
        title: 'Wrong tag',
        priceMin: '600.00',
        tags: ['birthday'],
      },
      {
        handle: 'too-expensive',
        title: 'Too expensive',
        priceMin: '900.00',
        tags: ['diwali'],
      },
    ]);
    const result = await harness.call<{
      products: Array<{ title: string }>;
    }>('search_products', { tag: 'diwali', priceMin: 500, priceMax: 800 });
    expect(result.data?.products.map((p) => p.title)).toEqual(['In band']);
    harness.tokenManager.stop();
  });

  it('ranks exact product phrase matches before broad token matches', async () => {
    const { harness } = buildCatalogHarness([
      {
        handle: 'kaju-marzipan-bon-bon-box',
        title: 'Kaju Marzipan Bon Bon Box',
        priceMin: '195.00',
      },
      {
        handle: 'best-kaju-katli-chocolate-barfi',
        title: 'Indie Bites - 54.5% Dark Chocolate Kaju Katli',
        priceMin: '515.00',
      },
      {
        handle: 'cheeky-kaju-bon-bons',
        title: 'Cheeky Kaju Bon Bons Box of 9',
        priceMin: '650.00',
      },
    ]);

    const result = await harness.call<{
      products: Array<{ title: string }>;
    }>('search_products', { query: 'Kaju Katli', limit: 3 });

    expect(result.data?.products.map((p) => p.title)).toEqual([
      'Indie Bites - 54.5% Dark Chocolate Kaju Katli',
      'Kaju Marzipan Bon Bon Box',
      'Cheeky Kaju Bon Bons Box of 9',
    ]);
    harness.tokenManager.stop();
  });

  it('accepts maxPrice alias and broadens personal gift searches locally', async () => {
    const { mock, harness } = buildCatalogHarness([
      {
        handle: 'under-budget',
        title: 'Under budget',
        priceMin: '350.00',
      },
      {
        handle: 'over-budget',
        title: 'Over budget',
        priceMin: '900.00',
      },
    ]);
    const result = await harness.call<{
      products: Array<{ title: string }>;
    }>('search_products', { query: 'birthday gift', maxPrice: 500 });

    expect(result.error).toBeUndefined();
    expect(result.data?.products.map((p) => p.title)).toEqual(['Under budget']);
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('infers an upper budget from free-text gift queries', async () => {
    const { mock, harness } = buildCatalogHarness([
      {
        handle: 'under-budget',
        title: 'Under Budget Birthday Box',
        priceMin: '350.00',
        tags: ['gift', 'birthday'],
      },
      {
        handle: 'over-budget',
        title: 'Premium Birthday Box',
        priceMin: '900.00',
        tags: ['gift', 'birthday'],
      },
    ]);
    const result = await harness.call<{
      products: Array<{ title: string }>;
    }>('search_products', { query: 'gift under 500' });

    expect(result.error).toBeUndefined();
    expect(result.data?.products.map((p) => p.title)).toEqual([
      'Under Budget Birthday Box',
    ]);
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('falls back locally to non-accessory products for accessory-only personal gift matches', async () => {
    const { mock, harness } = buildCatalogHarness([
      {
        handle: 'birthday-sleeve',
        title: 'Happy Birthday Sleeve',
        priceMin: '150.00',
        tags: ['birthday', 'gift'],
      },
      {
        handle: 'boondi-laddoo-box',
        title: 'Bounty-ful Boondi Laddoo Box',
        priceMin: '325.00',
        tags: ['mithai', 'gift'],
      },
      {
        handle: 'premium-box',
        title: 'Premium Mithai Box',
        priceMin: '900.00',
        tags: ['mithai', 'gift'],
      },
    ]);
    const result = await harness.call<{
      products: Array<{ title: string }>;
    }>('search_products', { query: 'gift birthday under 500', limit: 5 });

    expect(result.error).toBeUndefined();
    expect(result.data?.products.map((p) => p.title)).toEqual([
      'Bounty-ful Boondi Laddoo Box',
    ]);
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('caps personal gifting responses to three non-accessory cached products', async () => {
    const { harness } = buildCatalogHarness([
      {
        handle: 'saffron',
        title: 'Saffron in Glass Bottle',
        priceMin: '500.00',
        tags: ['roka', 'gift'],
      },
      {
        handle: 'fudge',
        title: "Bombay's 3-Layer Chocolate Fudge",
        priceMin: '350.00',
        tags: ['roka', 'gift'],
      },
      {
        handle: 'gift-bag',
        title: 'Small Coral Gift Bag',
        priceMin: '75.00',
        tags: ['roka', 'gift'],
      },
      {
        handle: 'third-box',
        title: 'Celebration Mithai Box',
        priceMin: '700.00',
        tags: ['roka', 'gift'],
      },
      {
        handle: 'fourth-box',
        title: 'Premium Mithai Box',
        priceMin: '800.00',
        tags: ['roka', 'gift'],
      },
      {
        handle: 'over-budget-snack-box',
        title: 'Bombay Sweet Shop Snack Box',
        priceMin: '990.00',
        tags: ['roka', 'gift'],
      },
    ]);
    const result = await harness.call<{
      products: Array<{ title: string }>;
    }>('search_products', {
      query: 'gifting roka mithai box celebration',
      priceMax: 900,
      limit: 5,
    });

    expect(result.error).toBeUndefined();
    expect(result.data?.products.map((p) => p.title)).toEqual([
      'Saffron in Glass Bottle',
      "Bombay's 3-Layer Chocolate Fudge",
      'Celebration Mithai Box',
    ]);
    expect(result.raw).not.toHaveProperty('customerReplyDraft');
    expect(result.raw).not.toHaveProperty('replyContract');
    expect(result.raw).not.toHaveProperty('replyFacts');
    expect(JSON.stringify(result.raw)).not.toMatch(/birthday/i);
    expect(JSON.stringify(result.raw)).not.toContain('Small Coral Gift Bag');
    expect(JSON.stringify(result.raw)).not.toContain(
      'Bombay Sweet Shop Snack Box',
    );
    harness.tokenManager.stop();
  });

  it('uses the requested limit for non-personal-gifting cached searches', async () => {
    const { harness } = buildCatalogHarness([
      {
        handle: 'wedding-hamper',
        title: 'Wedding Hamper',
        priceMin: '900.00',
        tags: ['wedding', 'gift'],
      },
      {
        handle: 'wedding-box',
        title: 'Wedding Box',
        priceMin: '800.00',
        tags: ['wedding', 'gift'],
      },
    ]);
    const result = await harness.call<{
      products: Array<{ title: string }>;
    }>('search_products', { query: 'gift hamper wedding', limit: 3 });

    expect(result.error).toBeUndefined();
    expect(result.raw).not.toHaveProperty('customerReplyDraft');
    expect(result.raw).not.toHaveProperty('replyContract');
    expect(result.data?.products.map((p) => p.title)).toEqual([
      'Wedding Hamper',
      'Wedding Box',
    ]);
    harness.tokenManager.stop();
  });

  it('returns safe empty products without live fallback when cache has no match', async () => {
    const { mock, harness } = buildCatalogHarness([]);
    const result = await harness.call<{
      products: Array<Record<string, unknown>>;
    }>('search_products', { query: 'durian cheesecake' });

    expect(result.error).toBeUndefined();
    expect(Object.keys(result.raw as Record<string, unknown>)).toEqual([
      'products',
    ]);
    expect(result.raw).not.toHaveProperty('customerReplyDraft');
    expect(result.data?.products).toEqual([]);
    expect(mock.graphqlCallCount()).toBe(0);
    expect(JSON.stringify(result.raw)).not.toContain("I couldn't find");
    expect(JSON.stringify(result.raw)).not.toMatch(/checking/i);
    harness.tokenManager.stop();
  });
});

describe('ProductCatalogCache', () => {
  it('preserves the last good catalog when refresh fails', async () => {
    const cache = new ProductCatalogCache();
    cache.replace([
      {
        handle: 'last-good',
        title: 'Last Good Box',
        priceMin: '500.00',
        priceMax: '500.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/last-good',
      },
    ]);

    const result = await cache.refresh(async () => {
      throw new Error('shopify timeout');
    });

    expect(result).toEqual({
      status: 'failed',
      count: 1,
      error: 'shopify timeout',
    });
    expect(cache.list()).toEqual([
      {
        handle: 'last-good',
        title: 'Last Good Box',
        priceMin: '500.00',
        priceMax: '500.00',
        currency: 'INR',
        url: 'https://shop.example.com/products/last-good',
      },
    ]);
  });
});

describe('get_product', () => {
  it('returns product when handle matches', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productByHandle({
            handle: 'kaju-katli',
            title: 'Kaju Katli Box',
            totalInventory: 50,
          }),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      product: { handle: string; available: boolean } | null;
    }>('get_product', { handleOrId: 'kaju-katli' });
    expect(result.data?.product?.handle).toBe('kaju-katli');
    expect(result.data?.product?.available).toBe(true);
    harness.tokenManager.stop();
  });

  it('accepts handle as a compatibility alias for handleOrId', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productByHandle({
            handle: 'chocolate-butterscotch-bark',
            title: 'Choco Butterscotch Barks (200g)',
          }),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      product: { handle: string; available: boolean } | null;
    }>('get_product', { handle: 'chocolate-butterscotch-bark' });
    expect(result.error).toBeUndefined();
    expect(result.data?.product?.handle).toBe('chocolate-butterscotch-bark');
    harness.tokenManager.stop();
  });

  it('accepts id as a compatibility alias for handleOrId', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk({
          product: productByHandle({
            id: 'gid://shopify/Product/8420946313465',
            handle: 'best-kaju-katli-chocolate-barfi',
            title: 'Indie Bites - 54.5% Dark Chocolate Kaju Katli',
          }).productByHandle,
        }),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      product: { handle: string; available: boolean } | null;
    }>('get_product', { id: 'gid://shopify/Product/8420946313465' });
    expect(result.error).toBeUndefined();
    expect(result.data?.product?.handle).toBe(
      'best-kaju-katli-chocolate-barfi',
    );
    harness.tokenManager.stop();
  });

  it('returns null when handle does not exist', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(emptyProductByHandle())],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{ product: unknown }>('get_product', {
      handleOrId: 'unknown-handle',
    });
    expect(result.data?.product).toBeNull();
    harness.tokenManager.stop();
  });
});

describe('check_inventory', () => {
  it('returns sufficient=true when stock exceeds requested', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(variantInventory(50))],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      totalQuantity: number;
      sufficient?: boolean;
    }>('check_inventory', {
      variantId: 'gid://shopify/ProductVariant/9999',
      requestedQuantity: 20,
    });
    expect(result.data?.totalQuantity).toBe(50);
    expect(result.data?.sufficient).toBe(true);
    harness.tokenManager.stop();
  });

  it('returns sufficient=false when stock below requested', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productInventoryByHandle(
            { handle: 'low-stock', title: 'Low Stock' },
            [
              { id: 'gid://shopify/ProductVariant/1', inventoryQuantity: 3 },
              { id: 'gid://shopify/ProductVariant/2', inventoryQuantity: 2 },
            ],
          ),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      sufficient?: boolean;
      totalQuantity: number;
    }>('check_inventory', {
      productHandle: 'low-stock',
      requestedQuantity: 20,
    });
    expect(result.data?.totalQuantity).toBe(5);
    expect(result.data?.sufficient).toBe(false);
    harness.tokenManager.stop();
  });
});

describe('validate_discount_code', () => {
  it('returns active+meetsMinimum=true', async () => {
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
      minimumOrderAmount?: number;
      meetsMinimum?: boolean;
    }>('validate_discount_code', { code: 'BSSDIWALI20', cartTotal: 1200 });
    expect(result.data?.exists).toBe(true);
    expect(result.data?.active).toBe(true);
    expect(result.data?.minimumOrderAmount).toBe(1000);
    expect(result.data?.meetsMinimum).toBe(true);
    harness.tokenManager.stop();
  });

  it('returns meetsMinimum=true when cartTotal is passed and discount has no minimum', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(discountNodes([{ title: 'NOMIN' }]))],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      exists: boolean;
      active: boolean;
      meetsMinimum?: boolean;
      minimumOrderAmount?: number;
    }>('validate_discount_code', { code: 'NOMIN', cartTotal: 99 });
    expect(result.data?.exists).toBe(true);
    expect(result.data?.active).toBe(true);
    expect(result.data?.meetsMinimum).toBe(true);
    expect(result.data?.minimumOrderAmount).toBeUndefined();
    harness.tokenManager.stop();
  });

  it('returns active=false with reason for expired code', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(discountNodes([{ title: 'OLDCODE', status: 'EXPIRED' }])),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      exists: boolean;
      active: boolean;
      reason?: string;
    }>('validate_discount_code', { code: 'OLDCODE' });
    expect(result.data?.exists).toBe(true);
    expect(result.data?.active).toBe(false);
    expect(result.data?.reason).toBe('expired');
    harness.tokenManager.stop();
  });

  it('returns exists=false when code is unknown', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk({ codeDiscountNodes: { edges: [] } })],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{ exists: boolean }>(
      'validate_discount_code',
      { code: 'NEVEREXISTED' },
    );
    expect(result.data?.exists).toBe(false);
    harness.tokenManager.stop();
  });
});
