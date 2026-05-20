import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ShopifyAdapterError } from '../errors.js';
import { FIND_ORDER_BY_NAME } from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import { verifyIdentity } from '../privacy/guard.js';
import { resolveEffectiveIdentity } from '../privacy/effective-identity.js';
import {
  buildOrderQueryClause,
  jsonContent,
  mapOrderResponse,
  toolErrorContent,
} from './shared.js';

const inputSchema = {
  orderNumber: z
    .string()
    .min(1)
    .describe(
      'Order identifier — accepts the display name (e.g. #1001 or BSS-2847), the numeric Shopify ID (e.g. 7057409966300), or the full GID (gid://shopify/Order/7057409966300).',
    ),
  callerPhone: z
    .string()
    .min(4)
    .optional()
    .describe(
      "Caller's phone number. Equally-valid identity axis with callerEmail; supply whichever the customer has. At least one of callerPhone/callerEmail is required unless a signed X-Caller-Identity header is present. If a value is supplied it must match the header's value.",
    ),
  callerEmail: z
    .string()
    .email()
    .optional()
    .describe(
      "Caller's email address. Equally-valid identity axis with callerPhone; supply whichever the customer has. At least one of callerPhone/callerEmail is required unless a signed X-Caller-Identity header is present. If a value is supplied it must match the header's value.",
    ),
};

interface OrderEdgesResponse {
  orders: { edges: Array<{ node: Parameters<typeof mapOrderResponse>[0] }> };
}

export function registerGetOrder(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    'get_order',
    "Read a Shopify order by order number. Privacy-guarded: the caller must control at least one identity axis (callerPhone or callerEmail) that matches the order's customer record. Returns full fulfillment, line items, totals.",
    inputSchema,
    async (args) => {
      try {
        const identity = resolveEffectiveIdentity({
          callerPhone: args.callerPhone,
          callerEmail: args.callerEmail,
        });

        const clause = buildOrderQueryClause(args.orderNumber);
        const data = await client.graphql<OrderEdgesResponse>(
          FIND_ORDER_BY_NAME,
          { query: clause.query },
        );
        const edges = data.orders?.edges ?? [];
        const node =
          clause.kind === 'name'
            ? (edges.find(
                (edge) =>
                  edge.node.name.replace(/^#/, '').toLowerCase() ===
                  clause.needle.toLowerCase(),
              )?.node ?? edges[0]?.node)
            : edges[0]?.node;
        if (!node) {
          throw new ShopifyAdapterError(
            'NOT_FOUND',
            `Order ${args.orderNumber} not found`,
          );
        }
        const order = mapOrderResponse(node);
        const guard = verifyIdentity({
          callerPhone: identity.phone,
          callerEmail: identity.email,
          customer: {
            phone: order.customer?.phone ?? null,
            email: order.customer?.email ?? null,
          },
        });
        if (!guard.ok) {
          throw new ShopifyAdapterError(
            'PRIVACY_GUARD_FAILED',
            `Caller identity could not be verified for order ${order.name}`,
            { reason: guard.reason },
          );
        }
        return jsonContent({
          order: {
            name: order.name,
            displayFinancialStatus: order.displayFinancialStatus,
            displayFulfillmentStatus: order.displayFulfillmentStatus,
            fulfillments: order.fulfillments,
            lineItems: order.lineItems,
            totalPriceSet: order.totalPriceSet,
            shippingAddress: order.shippingAddress,
            createdAt: order.createdAt,
            dispatchedAt: order.dispatchedAt,
            customerId: order.customerId,
            discountCodes: order.discountCodes,
          },
          matchedVia: guard.matchedVia,
          identitySource: identity.source,
        });
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
