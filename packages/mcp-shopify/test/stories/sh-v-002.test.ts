import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-V-002 voice — unknown caller asks about order', () => {
  it('caller phone matches owner -> order returned', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            { name: 'BSS-3303', customer: KNOWN_CUSTOMER },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{ order: { name: string } }>(
      'get_order',
      {
        orderNumber: 'BSS-3303',
        callerPhone: KNOWN_CUSTOMER.phone,
      },
    );
    expect(result.data?.order.name).toBe('#BSS-3303');
    harness.tokenManager.stop();
  });
});
