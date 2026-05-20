import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
  statusFilter: z.enum(['OPEN', 'CLOSED', 'ANY']).optional(),
  limit: z.number().int().min(1).max(25).optional(),
};

interface OrderEdgesResponse {
  orders: { edges: Array<{ node: Parameters<typeof mapOrderResponse>[0] }> };
}

function statusQuery(filter: 'OPEN' | 'CLOSED' | 'ANY'): string {
  switch (filter) {
    case 'CLOSED':
      return 'status:closed';
    case 'ANY':
      return 'status:any';
    case 'OPEN':
    default:
      return 'status:open';
  }
}

export function registerListOrdersForCustomer(
  server: McpServer,
  client: ShopifyClient,
  identityCache?: CustomerIdentityCache,
): void {
  server.tool(
    'list_orders_for_customer',
    'List recent Shopify orders for the verified caller (matched by phone/email). Defaults to OPEN orders, sorted newest first.',
    inputSchema,
    async (args) => {
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

        const filter = args.statusFilter ?? 'OPEN';
        const limit = args.limit ?? 10;
        const customerToken =
          ownership.resolvedId.split('/').pop() ?? ownership.resolvedId;
        const query = `customer_id:${customerToken} ${statusQuery(filter)}`;
        const data = await client.graphql<OrderEdgesResponse>(
          LIST_ORDERS_FOR_CUSTOMER,
          { query, first: limit },
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
        return toolErrorContent(err);
      }
    },
  );
}
