import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-012 refund demand (escalate)', () => {
  it('returns line items and totals so the agent can hand over context', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3170',
              customer: KNOWN_CUSTOMER,
              totalAmount: '3499.00',
              lineItems: [
                { title: 'Festive Hamper', quantity: 1, sku: 'FH-01' },
              ],
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const order = await harness.call<{
      order: {
        lineItems: Array<{ title: string }>;
        totalPriceSet: { amount: string };
      };
    }>('get_order', {
      orderNumber: 'BSS-3170',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(order.data?.order.lineItems[0].title).toBe('Festive Hamper');
    expect(order.data?.order.totalPriceSet.amount).toBe('3499.00');
    harness.tokenManager.stop();
  });
});
