import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-009 billing error (escalate)', () => {
  it('returns totalPriceSet and discountCodes so the agent can explain charges', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3160',
              customer: KNOWN_CUSTOMER,
              totalAmount: '2400.00',
              discountCodes: ['BSSDIWALI20'],
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const order = await harness.call<{
      order: {
        totalPriceSet: { amount: string; currencyCode: string };
        discountCodes: string[];
      };
    }>('get_order', {
      orderNumber: 'BSS-3160',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(order.data?.order.totalPriceSet.amount).toBe('2400.00');
    expect(order.data?.order.discountCodes).toEqual(['BSSDIWALI20']);
    harness.tokenManager.stop();
  });
});
