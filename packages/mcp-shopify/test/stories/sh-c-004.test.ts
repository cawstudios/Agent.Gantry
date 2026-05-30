import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-004 order delayed, proactive acknowledgement', () => {
  it('surfaces estimatedDeliveryAt before now while still in transit', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-2900',
              customer: KNOWN_CUSTOMER,
              fulfillment: 'IN_TRANSIT',
              estimatedDeliveryAt: past,
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const order = await harness.call<{
      order: {
        displayFulfillmentStatus: string;
        fulfillments: Array<{ estimatedDeliveryAt?: string }>;
      };
    }>('get_order', {
      orderNumber: 'BSS-2900',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(order.error).toBeUndefined();
    expect(order.data?.order.displayFulfillmentStatus).toBe('IN_TRANSIT');
    const eta = order.data?.order.fulfillments[0].estimatedDeliveryAt;
    expect(eta && new Date(eta).getTime() < Date.now()).toBe(true);
    harness.tokenManager.stop();
  });
});
