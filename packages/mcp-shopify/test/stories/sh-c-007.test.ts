import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import {
  customersEdges,
  graphqlErrors,
  graphqlOk,
  ordersEdges,
} from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-007 very old order (6+ months) — scope-gated', () => {
  it('with read_all_orders granted, returns the old order', async () => {
    const eightMonthsAgo = new Date(
      Date.now() - 8 * 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([KNOWN_CUSTOMER])),
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-1700',
              customer: KNOWN_CUSTOMER,
              createdAt: eightMonthsAgo,
              fulfillment: 'DELIVERED',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const history = await harness.call<{
      orders: Array<{ name: string; createdAt: string }>;
    }>('get_order_history', {
      customerId: KNOWN_CUSTOMER.id,
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(history.error).toBeUndefined();
    expect(history.data?.orders[0].name).toBe('#BSS-1700');
    harness.tokenManager.stop();
  });

  it('without read_all_orders, surfaces SCOPE_MISSING gracefully', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([KNOWN_CUSTOMER])),
        graphqlErrors([
          { message: 'read_all_orders scope requires merchant approval' },
        ]),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const history = await harness.call('get_order_history', {
      customerId: KNOWN_CUSTOMER.id,
      callerPhone: KNOWN_CUSTOMER.phone,
      since: '2024-01-01T00:00:00Z',
    });
    expect(history.error?.code).toBe('SCOPE_MISSING');
    harness.tokenManager.stop();
  });
});
