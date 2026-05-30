import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-005 damaged product reported (escalate)', () => {
  it('returns line items so the agent can attach order context for handoff', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3110',
              customer: KNOWN_CUSTOMER,
              fulfillment: 'DELIVERED',
              lineItems: [
                { title: 'Kaju Katli Box (250g)', quantity: 2, sku: 'KK-250' },
                { title: 'Mango Barfi (500g)', quantity: 1, sku: 'MB-500' },
              ],
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const order = await harness.call<{
      order: { lineItems: Array<{ title: string; quantity: number }> };
    }>('get_order', {
      orderNumber: 'BSS-3110',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(order.data?.order.lineItems).toHaveLength(2);
    expect(order.data?.order.lineItems[0].title).toBe('Kaju Katli Box (250g)');
    harness.tokenManager.stop();
  });
});
