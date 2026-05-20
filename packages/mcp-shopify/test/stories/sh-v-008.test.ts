import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, productByHandle } from '../fixtures/responses.js';

describe('SH-V-008 voice — wants to place new order (redirect)', () => {
  it('returns onlineStoreUrl that can be WhatsApped post-call', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productByHandle({
            handle: 'kaju-katli-deluxe',
            title: 'Kaju Katli Deluxe',
            onlineStoreUrl: 'https://shop.example.com/products/kaju-katli-deluxe',
          }),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      product: { onlineStoreUrl?: string } | null;
    }>('get_product', { handleOrId: 'kaju-katli-deluxe' });
    expect(result.data?.product?.onlineStoreUrl).toContain('shop.example.com');
    harness.tokenManager.stop();
  });
});
