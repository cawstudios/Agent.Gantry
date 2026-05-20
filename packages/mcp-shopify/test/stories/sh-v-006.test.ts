import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import {
  graphqlOk,
  productInventoryByHandle,
} from '../fixtures/responses.js';

describe('SH-V-006 voice — product availability before order', () => {
  it('sufficient stock for requested quantity', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productInventoryByHandle(
            { handle: 'kaju-gift-set', title: 'Kaju Gift Set' },
            [{ id: 'gid://shopify/ProductVariant/1', inventoryQuantity: 50 }],
          ),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      totalQuantity: number;
      sufficient?: boolean;
    }>('check_inventory', {
      productHandle: 'kaju-gift-set',
      requestedQuantity: 20,
    });
    expect(result.data?.sufficient).toBe(true);
    harness.tokenManager.stop();
  });

  it('insufficient stock for requested quantity', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productInventoryByHandle(
            { handle: 'kaju-gift-set', title: 'Kaju Gift Set' },
            [{ id: 'gid://shopify/ProductVariant/1', inventoryQuantity: 5 }],
          ),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{ sufficient?: boolean }>(
      'check_inventory',
      { productHandle: 'kaju-gift-set', requestedQuantity: 20 },
    );
    expect(result.data?.sufficient).toBe(false);
    harness.tokenManager.stop();
  });
});
