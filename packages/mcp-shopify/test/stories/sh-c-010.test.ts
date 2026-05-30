import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-010 bulk B2C order, off-platform customisation', () => {
  it('returns the order intact even without customisation notes', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3200',
              customer: KNOWN_CUSTOMER,
              lineItems: [
                { title: 'Wedding Favour Box (gold ribbon)', quantity: 25 },
              ],
              totalAmount: '12500.00',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const order = await harness.call<{
      order: { lineItems: Array<{ title: string; quantity: number }> };
    }>('get_order', {
      orderNumber: 'BSS-3200',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(order.error).toBeUndefined();
    expect(order.data?.order.lineItems[0].quantity).toBe(25);
    harness.tokenManager.stop();
  });
});
