import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-006 wrong items received (escalate)', () => {
  it('returns line items showing what was sent', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3120',
              customer: KNOWN_CUSTOMER,
              fulfillment: 'DELIVERED',
              lineItems: [
                { title: 'Soan Papdi', quantity: 1 },
              ],
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const order = await harness.call<{
      order: { lineItems: Array<{ title: string }> };
    }>('get_order', {
      orderNumber: 'BSS-3120',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(order.data?.order.lineItems[0].title).toBe('Soan Papdi');
    harness.tokenManager.stop();
  });
});
