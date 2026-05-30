import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import {
  customersEdges,
  graphqlOk,
  ordersEdges,
} from '../fixtures/responses.js';
import { RECOVERY_CUSTOMER } from '../fixtures/customers.js';

describe('SH-V-009 voice — phone not linked, email recovery', () => {
  it('lookup_customer (phone miss → email hit) -> get_order with recovery email', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        // lookup_customer: phone query → no match
        graphqlOk({ customers: { edges: [] } }),
        // lookup_customer: email fallback → match
        graphqlOk(customersEdges([RECOVERY_CUSTOMER])),
        // get_order: order found
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3500',
              customer: RECOVERY_CUSTOMER,
              fulfillment: 'IN_TRANSIT',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);

    const lookup = await harness.call<{
      found: boolean;
      matchedVia: string;
      customer?: { id: string };
    }>('lookup_customer', {
      phone: '+919800000999',
      email: RECOVERY_CUSTOMER.email,
    });
    expect(lookup.data?.found).toBe(true);
    expect(lookup.data?.matchedVia).toBe('email');

    const order = await harness.call<{
      order: { name: string; customerId: string };
      matchedVia: string;
    }>('get_order', {
      orderNumber: 'BSS-3500',
      callerPhone: '+919800000999',
      callerEmail: RECOVERY_CUSTOMER.email,
    });
    expect(order.error).toBeUndefined();
    expect(order.data?.matchedVia).toBe('email');
    expect(order.data?.order.customerId).toBe(RECOVERY_CUSTOMER.id);
    harness.tokenManager.stop();
  });
});
