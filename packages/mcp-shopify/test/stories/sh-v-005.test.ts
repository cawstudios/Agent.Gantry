import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-V-005 voice — delivered but not received', () => {
  it('surfaces DELIVERED status with tracking context', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3330',
              customer: KNOWN_CUSTOMER,
              fulfillment: 'DELIVERED',
              fulfillmentStatus: 'SUCCESS',
              trackingUrl: 'https://shipping.example.com/delivered',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      order: {
        displayFulfillmentStatus: string;
        fulfillments: Array<{ trackingUrl?: string }>;
      };
    }>('get_order', {
      orderNumber: 'BSS-3330',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(result.data?.order.displayFulfillmentStatus).toBe('DELIVERED');
    expect(result.data?.order.fulfillments[0].trackingUrl).toContain('delivered');
    harness.tokenManager.stop();
  });
});
