import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../../helpers/tool-harness.js';
import { buildMockFetch } from '../../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../../fixtures/responses.js';
import { KNOWN_CUSTOMER, RECOVERY_CUSTOMER } from '../../fixtures/customers.js';
import { runWithIdentity } from '../../../src/identity/identity-context.js';

const VERIFIED_HEADER_IDENTITY = {
  phone: KNOWN_CUSTOMER.phone,
  issuedAtMs: Date.now(),
};

describe('get_order with verified identity header (ALS)', () => {
  it('uses header phone when no callerPhone arg is supplied', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(ordersEdges([{ name: 'BSS-2847', customer: KNOWN_CUSTOMER }])),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await runWithIdentity(VERIFIED_HEADER_IDENTITY, () =>
      harness.call<{ order: { name: string }; identitySource: string }>(
        'get_order',
        { orderNumber: 'BSS-2847' },
      ),
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.order.name).toBe('#BSS-2847');
    expect(result.data?.identitySource).toBe('header');
    harness.tokenManager.stop();
  });

  it('accepts a callerPhone arg that matches the header', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(ordersEdges([{ name: 'BSS-2847', customer: KNOWN_CUSTOMER }])),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await runWithIdentity(VERIFIED_HEADER_IDENTITY, () =>
      harness.call('get_order', {
        orderNumber: 'BSS-2847',
        callerPhone: KNOWN_CUSTOMER.phone,
      }),
    );
    expect(result.error).toBeUndefined();
    harness.tokenManager.stop();
  });

  it('rejects when callerPhone arg disagrees with header phone (prompt-injection block)', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch);
    const result = await runWithIdentity(VERIFIED_HEADER_IDENTITY, () =>
      harness.call('get_order', {
        orderNumber: 'BSS-2847',
        callerPhone: '+919800000999',
      }),
    );
    expect(result.error?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((result.raw as { error: { reason: string } }).error.reason).toBe(
      'ARG_VS_HEADER_MISMATCH',
    );
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('rejects when callerEmail arg is supplied but header has no email (LLM injection)', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch);
    const result = await runWithIdentity(VERIFIED_HEADER_IDENTITY, () =>
      harness.call('get_order', {
        orderNumber: 'BSS-2847',
        callerEmail: 'attacker@example.com',
      }),
    );
    expect(result.error?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((result.raw as { error: { reason: string } }).error.reason).toBe(
      'ARG_VS_HEADER_MISMATCH',
    );
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('falls back to callerPhone arg when no header is present', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(ordersEdges([{ name: 'BSS-2847', customer: KNOWN_CUSTOMER }])),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      order: { name: string };
      identitySource: string;
    }>('get_order', {
      orderNumber: 'BSS-2847',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(result.error).toBeUndefined();
    expect(result.data?.identitySource).toBe('arg');
    harness.tokenManager.stop();
  });

  it('fails closed when no header AND no callerPhone arg', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call('get_order', {
      orderNumber: 'BSS-2847',
    });
    expect(result.error?.code).toBe('PRIVACY_GUARD_FAILED');
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('accepts email recovery from header for a phone-mismatched order', async () => {
    const headerIdentity = {
      phone: '+919800000888',
      email: RECOVERY_CUSTOMER.email,
      issuedAtMs: Date.now(),
    };
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-3500', customer: RECOVERY_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await runWithIdentity(headerIdentity, () =>
      harness.call<{
        order: { name: string };
        matchedVia: string;
      }>('get_order', { orderNumber: 'BSS-3500' }),
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.matchedVia).toBe('email');
    harness.tokenManager.stop();
  });
});
