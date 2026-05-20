import { ShopifyAdapterError } from '../errors.js';
import {
  FIND_CUSTOMER_BY_EMAIL,
  FIND_CUSTOMER_BY_PHONE,
} from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import type { ShopifyCustomer } from '../shopify/types.js';
import { normalizeEmail, normalizePhone } from './guard.js';
import type { EffectiveIdentity } from './effective-identity.js';
import type { CustomerIdentityCache } from './customer-identity-cache.js';

interface CustomerEdgesResponse {
  customers: { edges: Array<{ node: ShopifyCustomer }> };
}

/**
 * Resolves the verified caller to a Shopify customer record and asserts the
 * customerId the caller is asking about matches that record. Throws
 * PRIVACY_GUARD_FAILED if it doesn't.
 *
 * This is the privacy boundary for tools that take a `customerId` directly
 * (list_orders_for_customer, get_order_history). Without it, a prompt-injected
 * agent could list orders for any customerId it knows or guesses.
 *
 * If a {@link CustomerIdentityCache} is supplied, successful resolutions are
 * cached so subsequent calls for the same verified identity skip the lookup.
 */
export async function assertCustomerBelongsToCaller(
  client: ShopifyClient,
  identity: EffectiveIdentity,
  rawCustomerId: string,
  cache?: CustomerIdentityCache,
): Promise<{ resolvedId: string; matchedVia: 'phone' | 'email' }> {
  const wanted = normalizeShopifyCustomerId(rawCustomerId);

  // Cache fast path — skip Shopify if we've recently resolved this identity.
  if (cache) {
    const hit = cache.get({ phone: identity.phone, email: identity.email });
    if (hit) {
      if (normalizeShopifyCustomerId(hit.customerId) === wanted) {
        return { resolvedId: hit.customerId, matchedVia: hit.matchedVia };
      }
      throw new ShopifyAdapterError(
        'PRIVACY_GUARD_FAILED',
        'customerId does not belong to the verified caller (cached identity)',
        { reason: 'CUSTOMER_ID_MISMATCH' },
      );
    }
  }

  if (identity.phone) {
    const phone = normalizePhone(identity.phone);
    if (phone) {
      const data = await client.graphql<CustomerEdgesResponse>(
        FIND_CUSTOMER_BY_PHONE,
        { query: `phone:${phone}` },
      );
      const match = (data.customers?.edges ?? []).find(
        (edge) => normalizePhone(edge.node.phone) === phone,
      );
      if (match) {
        cache?.set(
          { phone: identity.phone, email: identity.email },
          match.node.id,
          'phone',
        );
        if (normalizeShopifyCustomerId(match.node.id) === wanted) {
          return { resolvedId: match.node.id, matchedVia: 'phone' };
        }
        throw new ShopifyAdapterError(
          'PRIVACY_GUARD_FAILED',
          'customerId does not belong to the verified caller (phone path)',
          { reason: 'CUSTOMER_ID_MISMATCH' },
        );
      }
    }
  }

  if (identity.email) {
    const email = normalizeEmail(identity.email);
    if (email) {
      const data = await client.graphql<CustomerEdgesResponse>(
        FIND_CUSTOMER_BY_EMAIL,
        { query: `email:${email}` },
      );
      const match = (data.customers?.edges ?? []).find(
        (edge) => normalizeEmail(edge.node.email) === email,
      );
      if (match) {
        cache?.set(
          { phone: identity.phone, email: identity.email },
          match.node.id,
          'email',
        );
        if (normalizeShopifyCustomerId(match.node.id) === wanted) {
          return { resolvedId: match.node.id, matchedVia: 'email' };
        }
        throw new ShopifyAdapterError(
          'PRIVACY_GUARD_FAILED',
          'customerId does not belong to the verified caller (email path)',
          { reason: 'CUSTOMER_ID_MISMATCH' },
        );
      }
    }
  }

  throw new ShopifyAdapterError(
    'PRIVACY_GUARD_FAILED',
    'verified caller does not correspond to any known customer',
    { reason: 'CALLER_NOT_FOUND' },
  );
}

const GID_PREFIX = 'gid://shopify/Customer/';

function normalizeShopifyCustomerId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(GID_PREFIX)) {
    const numeric = trimmed.slice(GID_PREFIX.length).split('?')[0];
    return numeric;
  }
  return trimmed;
}
