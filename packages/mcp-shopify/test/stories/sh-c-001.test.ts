import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import {
  customersEdges,
  graphqlOk,
  ordersEdges,
} from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-001 known customer, order on track', () => {
  it('resolves customer -> open orders -> get_order with full tracking', async () => {
    const orderInput = {
      name: 'BSS-2847',
      customer: KNOWN_CUSTOMER,
      fulfillment: 'IN_TRANSIT',
      estimatedDeliveryAt: '2026-05-18T18:00:00Z',
      trackingUrl: 'https://shipping.example.com/track/abc',
      trackingCompany: 'BlueDart',
    };
    const mock = buildMockFetch({
      graphqlResponses: [
        // 1) lookup_customer_by_phone
        graphqlOk(customersEdges([KNOWN_CUSTOMER])),
        // 2) list_orders_for_customer ownership lookup
        graphqlOk(customersEdges([KNOWN_CUSTOMER])),
        // 3) list_orders_for_customer orders
        graphqlOk(ordersEdges([orderInput])),
        // 4) get_order
        graphqlOk(ordersEdges([orderInput])),
      ],
    });
    const harness = buildToolHarness(mock.fetch);

    const lookup = await harness.call<{
      found: boolean;
      customer?: { id: string };
    }>('lookup_customer', { phone: KNOWN_CUSTOMER.phone });
    expect(lookup.data?.found).toBe(true);

    const orders = await harness.call<{ orders: Array<{ name: string }> }>(
      'list_orders_for_customer',
      {
        customerId: lookup.data!.customer!.id,
        callerPhone: KNOWN_CUSTOMER.phone,
        statusFilter: 'OPEN',
      },
    );
    expect(orders.data?.orders[0].name).toBe('#BSS-2847');

    const order = await harness.call<{
      order: {
        name: string;
        fulfillments: Array<{ trackingUrl?: string; estimatedDeliveryAt?: string }>;
      };
    }>('get_order', {
      orderNumber: 'BSS-2847',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(order.data?.order.fulfillments[0].trackingUrl).toBe(
      orderInput.trackingUrl,
    );
    expect(order.data?.order.fulfillments[0].estimatedDeliveryAt).toBe(
      orderInput.estimatedDeliveryAt,
    );
    harness.tokenManager.stop();
  });
});
