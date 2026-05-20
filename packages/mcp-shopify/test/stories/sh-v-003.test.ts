import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-V-003 voice — damaged/wrong order (escalate)', () => {
  it('surfaces line items for voice handoff', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3310',
              customer: KNOWN_CUSTOMER,
              fulfillment: 'DELIVERED',
              lineItems: [{ title: 'Mango Barfi 500g', quantity: 1 }],
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      order: { lineItems: Array<{ title: string }> };
    }>('get_order', {
      orderNumber: 'BSS-3310',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(result.data?.order.lineItems[0].title).toBe('Mango Barfi 500g');
    harness.tokenManager.stop();
  });
});
