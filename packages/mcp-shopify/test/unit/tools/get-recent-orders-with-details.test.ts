import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../../helpers/tool-harness.js';
import { buildMockFetch } from '../../helpers/mock-fetch.js';
import {
  customersEdges,
  graphqlOk,
  ordersEdges,
} from '../../fixtures/responses.js';
import { BUSY_CUSTOMER } from '../../fixtures/customers.js';
import { runWithIdentity } from '../../../src/identity/identity-context.js';
import { CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE } from '../../../src/privacy/customer-safe-response.js';

const VERIFIED_BUSY_CUSTOMER = {
  phone: BUSY_CUSTOMER.phone,
  issuedAtMs: Date.now(),
};

interface DetailedOrder {
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  total: { amount: string; currencyCode: string };
  items: Array<{ title: string; quantity: number }>;
  fulfillments: Array<{
    status: string;
    trackingCompany: string | null;
    trackingNumber: string | null;
  }>;
}

describe('get_recent_orders_with_details', () => {
  it('returns the requested latest orders WITH line items in one call, newest first', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3001',
              customer: BUSY_CUSTOMER,
              createdAt: '2026-05-16T08:00:00Z',
              lineItems: [
                { title: 'Kaju Katli Box', quantity: 2, sku: 'KK-250' },
                { title: 'Choco Barks', quantity: 1, sku: 'CB-200' },
              ],
            },
            {
              name: 'BSS-3002',
              customer: BUSY_CUSTOMER,
              createdAt: '2026-05-17T08:00:00Z',
              lineItems: [{ title: 'Motichoor Ladoo', quantity: 4 }],
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_BUSY_CUSTOMER, () =>
      harness.call<{ orders: DetailedOrder[] }>(
        'get_recent_orders_with_details',
        { callerPhone: BUSY_CUSTOMER.phone, limit: 2 },
      ),
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.orders.map((o) => o.name)).toEqual([
      '#BSS-3002',
      '#BSS-3001',
    ]);
    expect(result.data?.orders[1]?.items).toEqual([
      { title: 'Kaju Katli Box', quantity: 2 },
      { title: 'Choco Barks', quantity: 1 },
    ]);
    expect(result.data?.orders[0]?.fulfillments[0]?.trackingCompany).toBe(
      'BlueDart',
    );
    expect(result.data?.orders[0]?.total).toEqual({
      amount: '1200.00',
      currencyCode: 'INR',
    });
    harness.tokenManager.stop();
  });

  it('asks for ALL statuses with a one-order default limit (payload discipline)', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(ordersEdges([])),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_BUSY_CUSTOMER, () =>
      harness.call('get_recent_orders_with_details', {
        callerPhone: BUSY_CUSTOMER.phone,
      }),
    );
    expect(result.error).toBeUndefined();
    const orderCall = mock.calls.find((c) => {
      const vars = (c.body as { variables?: { query?: string } })?.variables;
      return typeof vars?.query === 'string' && vars.query.includes('status:');
    });
    expect(orderCall).toBeDefined();
    const vars = (
      orderCall!.body as { variables: { query: string; first: number } }
    ).variables;
    expect(vars.query).toContain('status:any');
    expect(vars.first).toBe(1);
    harness.tokenManager.stop();
  });

  it('keeps the per-order payload lean: no customer block, no GID, no sku', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3001',
              customer: BUSY_CUSTOMER,
              lineItems: [{ title: 'Kaju Katli', quantity: 1, sku: 'KK-1' }],
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_BUSY_CUSTOMER, () =>
      harness.call<{ orders: Array<Record<string, unknown>> }>(
        'get_recent_orders_with_details',
        { callerPhone: BUSY_CUSTOMER.phone },
      ),
    );
    expect(result.error).toBeUndefined();
    const order = result.data?.orders[0];
    expect(order).toBeDefined();
    expect(order).not.toHaveProperty('customer');
    expect(order).not.toHaveProperty('customerId');
    expect(order).not.toHaveProperty('id');
    expect(JSON.stringify(order)).not.toContain('sku');
    harness.tokenManager.stop();
  });

  it('rejects when no identity is supplied', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await harness.call('get_recent_orders_with_details', {});
    expect(result.error?.message).toBe(
      CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE,
    );
    expect(JSON.stringify(result.raw)).not.toMatch(
      /Gantry|MCP|config|identity[_ -]?header|X-Caller|privacy[ _-]?guard|PRIVACY_GUARD|signed channel|admin bypass|Shopify Admin|bypass|tool error|error code/i,
    );
    harness.tokenManager.stop();
  });
});
