import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-002 order number provided directly', () => {
  it('returns order when caller phone matches', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-2847', customer: KNOWN_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{ order: { name: string } }>(
      'get_order',
      {
        orderNumber: 'BSS-2847',
        callerPhone: KNOWN_CUSTOMER.phone,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.order.name).toBe('#BSS-2847');
    harness.tokenManager.stop();
  });

  it('blocks privacy leak when caller phone does not match', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-2847', customer: KNOWN_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call('get_order', {
      orderNumber: 'BSS-2847',
      callerPhone: '+919999999999',
    });
    expect(result.error?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((result.raw as { order?: unknown }).order).toBeUndefined();
    harness.tokenManager.stop();
  });
});
