import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import {
  customersEdges,
  graphqlOk,
  ordersEdges,
} from '../fixtures/responses.js';
import { BUSY_CUSTOMER } from '../fixtures/customers.js';

describe('SH-V-007 voice — multiple active orders (disambiguation)', () => {
  it('returns three open orders sorted by createdAt desc', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(
          ordersEdges([
            { name: 'BSS-3400', customer: BUSY_CUSTOMER, createdAt: '2026-05-14T10:00:00Z' },
            { name: 'BSS-3401', customer: BUSY_CUSTOMER, createdAt: '2026-05-16T10:00:00Z' },
            { name: 'BSS-3402', customer: BUSY_CUSTOMER, createdAt: '2026-05-17T10:00:00Z' },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      orders: Array<{ name: string; createdAt: string }>;
    }>('list_orders_for_customer', {
      customerId: BUSY_CUSTOMER.id,
      callerPhone: BUSY_CUSTOMER.phone,
      statusFilter: 'OPEN',
    });
    expect(result.data?.orders.map((o) => o.name)).toEqual([
      '#BSS-3402',
      '#BSS-3401',
      '#BSS-3400',
    ]);
    harness.tokenManager.stop();
  });
});
