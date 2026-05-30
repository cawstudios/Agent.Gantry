import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { customersEdges, graphqlOk } from '../fixtures/responses.js';
import { RECOVERY_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-003 no order number, phone not linked', () => {
  it('lookup_customer falls back to email when phone returns no match', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        // phone lookup → no match
        graphqlOk({ customers: { edges: [] } }),
        // email lookup → found
        graphqlOk(customersEdges([RECOVERY_CUSTOMER])),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      found: boolean;
      matchedVia: string;
      customer?: { id: string };
    }>('lookup_customer', {
      // Caller's verified phone is not in Shopify (the "phone not linked" case).
      // Email is the recovery axis.
      phone: '+919800000900',
      email: RECOVERY_CUSTOMER.email,
    });
    expect(result.data?.found).toBe(true);
    expect(result.data?.matchedVia).toBe('email');
    expect(result.data?.customer?.id).toBe(RECOVERY_CUSTOMER.id);
    harness.tokenManager.stop();
  });
});
