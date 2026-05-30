import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-V-010 voice — after hours, no agents', () => {
  it('MCP server has no "after hours" gating — tool calls succeed', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([
            { name: 'BSS-3600', customer: KNOWN_CUSTOMER },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{ order: { name: string } }>(
      'get_order',
      {
        orderNumber: 'BSS-3600',
        callerPhone: KNOWN_CUSTOMER.phone,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.order.name).toBe('#BSS-3600');
    harness.tokenManager.stop();
  });
});
