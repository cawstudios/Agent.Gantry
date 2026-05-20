import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../../helpers/tool-harness.js';
import { buildMockFetch } from '../../helpers/mock-fetch.js';
import { customersEdges, graphqlOk } from '../../fixtures/responses.js';
import { KNOWN_CUSTOMER, RECOVERY_CUSTOMER } from '../../fixtures/customers.js';
import { runWithIdentity } from '../../../src/identity/identity-context.js';

describe('lookup_customer — phone path', () => {
  it('returns customer when phone arg matches (no header, arg-only identity)', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(customersEdges([KNOWN_CUSTOMER]))],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      found: boolean;
      matchedVia: string;
      customer?: { id: string; phone: string };
    }>('lookup_customer', { phone: KNOWN_CUSTOMER.phone });
    expect(result.error).toBeUndefined();
    expect(result.data?.found).toBe(true);
    expect(result.data?.matchedVia).toBe('phone');
    expect(result.data?.customer?.id).toBe(KNOWN_CUSTOMER.id);
    harness.tokenManager.stop();
  });

  it('normalizes equivalent phone formats before querying', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(customersEdges([KNOWN_CUSTOMER]))],
    });
    const harness = buildToolHarness(mock.fetch);
    await harness.call('lookup_customer', { phone: '+91-98765-43210' });
    expect(mock.calls[1]?.body).toMatchObject({
      variables: { query: 'phone:+919876543210' },
    });
    harness.tokenManager.stop();
  });

  it('returns found=false when no customer matches', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk({ customers: { edges: [] } })],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{ found: boolean }>('lookup_customer', {
      phone: '+919876543210',
    });
    expect(result.data?.found).toBe(false);
    harness.tokenManager.stop();
  });
});

describe('lookup_customer — email path', () => {
  it('returns customer when email arg matches (no header)', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(customersEdges([KNOWN_CUSTOMER]))],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      found: boolean;
      matchedVia: string;
    }>('lookup_customer', { email: 'Aanya.Shah@example.com' });
    expect(result.data?.found).toBe(true);
    expect(result.data?.matchedVia).toBe('email');
    harness.tokenManager.stop();
  });
});

describe('lookup_customer — input validation', () => {
  it('rejects when neither phone nor email is supplied', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call('lookup_customer', {});
    expect(result.error?.code).toBe('INVALID_REQUEST');
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });
});

describe('lookup_customer — identity-bound (header)', () => {
  it('rejects when arg phone disagrees with header phone', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch);
    const result = await runWithIdentity(
      { phone: KNOWN_CUSTOMER.phone, issuedAtMs: Date.now() },
      () =>
        harness.call('lookup_customer', { phone: '+919999999999' }),
    );
    expect(result.error?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((result.raw as { error: { reason: string } }).error.reason).toBe(
      'ARG_VS_HEADER_MISMATCH',
    );
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('rejects when arg email disagrees with header email', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch);
    const result = await runWithIdentity(
      { email: KNOWN_CUSTOMER.email, issuedAtMs: Date.now() },
      () =>
        harness.call('lookup_customer', { email: 'attacker@example.com' }),
    );
    expect(result.error?.code).toBe('PRIVACY_GUARD_FAILED');
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('rejects when LLM injects an email the header did not authenticate (phone-only header)', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch);
    const result = await runWithIdentity(
      { phone: KNOWN_CUSTOMER.phone, issuedAtMs: Date.now() },
      () =>
        harness.call('lookup_customer', { email: 'attacker@example.com' }),
    );
    expect(result.error?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((result.raw as { error: { reason: string } }).error.reason).toBe(
      'ARG_VS_HEADER_MISMATCH',
    );
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('falls back to email lookup when phone path returns no customer', async () => {
    // Header authenticates both phone and email.
    // Shopify returns no match for phone, but does for email.
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk({ customers: { edges: [] } }),
        graphqlOk(customersEdges([RECOVERY_CUSTOMER])),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await runWithIdentity(
      {
        phone: RECOVERY_CUSTOMER.phone,
        email: RECOVERY_CUSTOMER.email,
        issuedAtMs: Date.now(),
      },
      () =>
        harness.call<{
          found: boolean;
          matchedVia: string;
        }>('lookup_customer', {
          phone: RECOVERY_CUSTOMER.phone,
          email: RECOVERY_CUSTOMER.email,
        }),
    );
    expect(result.data?.found).toBe(true);
    expect(result.data?.matchedVia).toBe('email');
    harness.tokenManager.stop();
  });
});
