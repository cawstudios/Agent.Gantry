import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../helpers/tool-harness.js';
import { buildMockFetch } from '../helpers/mock-fetch.js';
import { jsonResponse } from '../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../fixtures/customers.js';

describe('SH-C-011 Shopify API down', () => {
  it('retries and surfaces UNAVAILABLE within the time budget', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        () => jsonResponse({ error: 'gateway' }, 503),
        () => jsonResponse({ error: 'gateway' }, 503),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const start = Date.now();
    const result = await harness.call('get_order', {
      orderNumber: 'BSS-9999',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    const elapsed = Date.now() - start;
    expect(result.error?.code).toBe('UNAVAILABLE');
    expect(elapsed).toBeLessThan(3000);
    harness.tokenManager.stop();
  });
});
