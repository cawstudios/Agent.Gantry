import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ShopifyAdapterError } from '../errors.js';
import { LIST_ORDERS_FOR_CUSTOMER } from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import { resolveEffectiveIdentity } from '../privacy/effective-identity.js';
import { assertCustomerBelongsToCaller } from '../privacy/customer-belongs-to-caller.js';
import type { CustomerIdentityCache } from '../privacy/customer-identity-cache.js';
import {
  jsonContent,
  mapOrderResponse,
  summarizeOrder,
  toolErrorContent,
} from './shared.js';

const inputSchema = {
  customerId: z
    .string()
    .min(1)
    .describe(
      'Shopify customer GID or numeric ID. Must belong to the verified caller (privacy guard).',
    ),
  callerPhone: z
    .string()
    .min(4)
    .optional()
    .describe(
      "Caller's phone number. Equally-valid identity axis with callerEmail. At least one of callerPhone/callerEmail is required unless a signed X-Caller-Identity header is present.",
    ),
  callerEmail: z
    .string()
    .email()
    .optional()
    .describe(
      "Caller's email. Equally-valid identity axis with callerPhone.",
    ),
  since: z
    .string()
    .optional()
    .describe('Inclusive ISO start date. Defaults to 3 months ago.'),
  until: z
    .string()
    .optional()
    .describe('Exclusive ISO end date. Defaults to now.'),
};

interface OrderEdgesResponse {
  orders: { edges: Array<{ node: Parameters<typeof mapOrderResponse>[0] }> };
}

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

export function registerGetOrderHistory(
  server: McpServer,
  client: ShopifyClient,
  identityCache?: CustomerIdentityCache,
): void {
  server.tool(
    'get_order_history',
    'Read order history for the verified caller across a date range. Defaults to the past 3 months when `since` is unset. Beyond 60 days requires the read_all_orders Shopify scope; throws SCOPE_MISSING if not granted.',
    inputSchema,
    async (args) => {
      const now = Date.now();
      const sinceMs = args.since
        ? Date.parse(args.since)
        : now - THREE_MONTHS_MS;
      const untilMs = args.until ? Date.parse(args.until) : now;
      if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) {
        return toolErrorContent(
          'INVALID_REQUEST',
          'since/until must be ISO 8601 dates',
        );
      }
      try {
        const identity = resolveEffectiveIdentity({
          callerPhone: args.callerPhone,
          callerEmail: args.callerEmail,
        });
        const ownership = await assertCustomerBelongsToCaller(
          client,
          identity,
          args.customerId,
          identityCache,
        );

        const customerToken =
          ownership.resolvedId.split('/').pop() ?? ownership.resolvedId;
        const sinceIso = new Date(sinceMs).toISOString();
        const untilIso = new Date(untilMs).toISOString();
        const query = `customer_id:${customerToken} created_at:>=${sinceIso} created_at:<${untilIso}`;
        const data = await client.graphql<OrderEdgesResponse>(
          LIST_ORDERS_FOR_CUSTOMER,
          { query, first: 25 },
        );
        const orders = (data.orders?.edges ?? [])
          .map((edge) => summarizeOrder(mapOrderResponse(edge.node)))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return jsonContent({
          orders,
          matchedVia: ownership.matchedVia,
          identitySource: identity.source,
        });
      } catch (err) {
        if (
          err instanceof ShopifyAdapterError &&
          err.code === 'SCOPE_MISSING' &&
          now - sinceMs > SIXTY_DAYS_MS
        ) {
          return toolErrorContent(
            new ShopifyAdapterError(
              'SCOPE_MISSING',
              'read_all_orders scope is required to read orders older than 60 days',
              err.details,
            ),
          );
        }
        return toolErrorContent(err);
      }
    },
  );
}
