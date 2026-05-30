import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-008 cancel/modify request after dispatch (escalate)', () => {
  it('surfaces dispatched/FULFILLED state for the agent', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3155',
              customer: KNOWN_CUSTOMER,
              fulfillment: 'FULFILLED',
              fulfillmentStatus: 'SUCCESS',
              processedAt: '2026-05-16T09:00:00Z',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const order = await harness.call<{
      order: { displayFulfillmentStatus: string; dispatchedAt?: string };
    }>('get_order', {
      orderNumber: 'BSS-3155',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(order.data?.order.displayFulfillmentStatus).toBe('FULFILLED');
    expect(order.data?.order.dispatchedAt).toBe('2026-05-16T09:00:00Z');
    harness.tokenManager.stop();
  });
});
