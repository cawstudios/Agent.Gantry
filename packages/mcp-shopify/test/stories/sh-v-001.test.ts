import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import {
  customersEdges,
  graphqlOk,
  ordersEdges,
} from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-V-001 voice — known caller, proactive surface', () => {
  it('lookup by phone then proactively pulls open order', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        // lookup_customer_by_phone
        graphqlOk(customersEdges([KNOWN_CUSTOMER])),
        // list_orders_for_customer ownership lookup
        graphqlOk(customersEdges([KNOWN_CUSTOMER])),
        // list_orders_for_customer orders
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3300',
              customer: KNOWN_CUSTOMER,
              fulfillment: 'IN_TRANSIT',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const lookup = await harness.call<{ customer?: { id: string } }>(
      'lookup_customer',
      { phone: KNOWN_CUSTOMER.phone },
    );
    const orders = await harness.call<{
      orders: Array<{ name: string }>;
    }>('list_orders_for_customer', {
      customerId: lookup.data!.customer!.id,
      callerPhone: KNOWN_CUSTOMER.phone,
      statusFilter: 'OPEN',
    });
    expect(orders.data?.orders[0].name).toBe('#BSS-3300');
    harness.tokenManager.stop();
  });
});
