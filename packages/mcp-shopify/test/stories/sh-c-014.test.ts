import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import {
  customersEdges,
  graphqlOk,
  ordersEdges,
  productByHandle,
} from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-014 returning buyer wants to reorder', () => {
  it('chains lookup → closed orders → product handle resolution', async () => {
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
              name: 'BSS-2401',
              customer: KNOWN_CUSTOMER,
              fulfillment: 'DELIVERED',
              lineItems: [
                { title: 'Kaju Katli Box', quantity: 2, sku: 'KK-250' },
              ],
            },
          ]),
        ),
        // get_product
        graphqlOk(productByHandle({ handle: 'kaju-katli', title: 'Kaju Katli' })),
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
      statusFilter: 'CLOSED',
    });
    expect(orders.data?.orders[0].name).toBe('#BSS-2401');
    const product = await harness.call<{ product: { handle: string } | null }>(
      'get_product',
      { handleOrId: 'kaju-katli' },
    );
    expect(product.data?.product?.handle).toBe('kaju-katli');
    harness.tokenManager.stop();
  });
});
