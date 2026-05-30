import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-V-004 voice — cancel after dispatch (escalate)', () => {
  it('surfaces FULFILLED or IN_TRANSIT state', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3320',
              customer: KNOWN_CUSTOMER,
              fulfillment: 'IN_TRANSIT',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      order: { displayFulfillmentStatus: string };
    }>('get_order', {
      orderNumber: 'BSS-3320',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(['FULFILLED', 'IN_TRANSIT']).toContain(
      result.data?.order.displayFulfillmentStatus,
    );
    harness.tokenManager.stop();
  });
});
