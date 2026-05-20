import { describe, expect, it } from 'vitest';
import { ShopifyClient } from '../../../src/shopify/client.js';
import { TokenManager } from '../../../src/auth/token-manager.js';
import { ShopifyAdapterError } from '../../../src/errors.js';
import { graphqlErrors, tokenResponse } from '../../fixtures/responses.js';

function buildClient() {
  const fetchImpl = (async (url: string | URL) => {
    if (url.toString().includes('/oauth/access_token')) return tokenResponse();
    throw new Error('unexpected fetch');
  }) as unknown as typeof fetch;

  const tokenManager = new TokenManager({
    shopDomain: 'test.myshopify.com',
    clientId: 'cid',
    clientSecret: 'secret',
    fetchImpl,
  });
  return { tokenManager, fetchImpl };
}

function clientWithGraphqlResponse(response: Response) {
  const tm = buildClient().tokenManager;
  let tokenServed = false;
  const fetchImpl = (async (input: string | URL) => {
    if (input.toString().includes('/oauth/access_token')) {
      if (tokenServed) return tokenResponse();
      tokenServed = true;
      return tokenResponse();
    }
    return response;
  }) as unknown as typeof fetch;
  const client = new ShopifyClient({
    shopDomain: 'test.myshopify.com',
    apiVersion: '2026-04',
    tokenManager: tm,
    fetchImpl,
    maxAttempts: 1,
    initialDelayMs: 1,
    maxDelayMs: 4,
  });
  return { client, tokenManager: tm };
}

describe('ShopifyClient error classification', () => {
  it('detects PCD by the real Shopify message string', async () => {
    const { client, tokenManager } = clientWithGraphqlResponse(
      graphqlErrors([
        {
          message:
            'This app is not approved to access the Customer object. See https://shopify.dev/docs/apps/launch/protected-customer-data for more details.',
        },
      ]),
    );
    await expect(
      client.graphql('{ customers(first: 1) { edges { node { id } } } }'),
    ).rejects.toMatchObject({ code: 'PROTECTED_DATA_REDACTED' });
    tokenManager.stop();
  });

  it('detects PCD by the ACCESS_DENIED extension code with a protected-customer-data URL', async () => {
    const { client, tokenManager } = clientWithGraphqlResponse(
      new Response(
        JSON.stringify({
          errors: [
            {
              message: 'denied',
              extensions: { code: 'ACCESS_DENIED' },
              path: ['customers'],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(client.graphql('{ x }')).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    tokenManager.stop();
  });

  it('detects SCOPE_MISSING for read_all_orders hints', async () => {
    const { client, tokenManager } = clientWithGraphqlResponse(
      graphqlErrors([
        { message: 'read_all_orders scope requires merchant approval' },
      ]),
    );
    await expect(client.graphql('{ x }')).rejects.toMatchObject({
      code: 'SCOPE_MISSING',
    });
    tokenManager.stop();
  });

  it('PCD detection precedes generic SCOPE_MISSING when both could match', async () => {
    // 'not approved to access the customer' should be PCD,
    // even though 'requires approval' could match SCOPE_MISSING.
    const { client, tokenManager } = clientWithGraphqlResponse(
      graphqlErrors([
        {
          message:
            'This app is not approved to access the Customer object — requires approval',
        },
      ]),
    );
    const err = await client
      .graphql('{ x }')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyAdapterError);
    expect((err as ShopifyAdapterError).code).toBe('PROTECTED_DATA_REDACTED');
    tokenManager.stop();
  });

  it('plain ACCESS_DENIED (no PCD or scope hints) maps to ACCESS_DENIED (not SCOPE_MISSING)', async () => {
    const { client, tokenManager } = clientWithGraphqlResponse(
      new Response(
        JSON.stringify({
          errors: [
            {
              message: 'Store suspended',
              extensions: { code: 'ACCESS_DENIED' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(client.graphql('{ x }')).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    tokenManager.stop();
  });

  it('unclassified errors fall through to INVALID_REQUEST', async () => {
    const { client, tokenManager } = clientWithGraphqlResponse(
      graphqlErrors([{ message: 'unhelpful generic graphql error' }]),
    );
    await expect(client.graphql('{ x }')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    tokenManager.stop();
  });

  it('passes through error details when present', async () => {
    const { client, tokenManager } = clientWithGraphqlResponse(
      graphqlErrors([{ message: 'not approved to access the Customer object' }]),
    );
    const err = await client
      .graphql('{ x }')
      .catch((e: unknown) => e as ShopifyAdapterError);
    expect((err as ShopifyAdapterError).details).toHaveProperty('errors');
    tokenManager.stop();
  });
});
