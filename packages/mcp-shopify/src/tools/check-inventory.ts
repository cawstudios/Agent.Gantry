import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CHECK_INVENTORY_BY_HANDLE,
  CHECK_INVENTORY_BY_VARIANT,
} from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import { jsonContent, toolErrorContent } from './shared.js';

const inputSchema = {
  variantId: z.string().optional(),
  productHandle: z.string().optional(),
  requestedQuantity: z.number().int().nonnegative().optional(),
};

interface VariantInventoryResponse {
  productVariant: {
    id: string;
    inventoryQuantity?: number | null;
    availableForSale?: boolean;
  } | null;
}

interface HandleInventoryResponse {
  productByHandle: {
    id: string;
    totalInventory?: number | null;
    variants?: {
      edges: Array<{
        node: {
          id: string;
          inventoryQuantity?: number | null;
          availableForSale?: boolean;
        };
      }>;
    } | null;
  } | null;
}

export function registerCheckInventory(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    'check_inventory',
    'Read the inventory level for a product or variant. Optionally compare against a requested quantity.',
    inputSchema,
    async (args) => {
      if (!args.variantId && !args.productHandle) {
        return toolErrorContent(
          'INVALID_REQUEST',
          'Provide variantId or productHandle',
        );
      }
      try {
        let total = 0;
        let outOfStock = true;
        if (args.variantId) {
          const data = await client.graphql<VariantInventoryResponse>(
            CHECK_INVENTORY_BY_VARIANT,
            { id: args.variantId },
          );
          const variant = data.productVariant;
          if (!variant) {
            return jsonContent({
              totalQuantity: 0,
              outOfStock: true,
              sufficient:
                typeof args.requestedQuantity === 'number' ? false : undefined,
            });
          }
          total = variant.inventoryQuantity ?? 0;
          outOfStock = !(variant.availableForSale ?? total > 0);
        } else if (args.productHandle) {
          const data = await client.graphql<HandleInventoryResponse>(
            CHECK_INVENTORY_BY_HANDLE,
            { handle: args.productHandle },
          );
          const product = data.productByHandle;
          if (!product) {
            return jsonContent({
              totalQuantity: 0,
              outOfStock: true,
              sufficient:
                typeof args.requestedQuantity === 'number' ? false : undefined,
            });
          }
          total =
            product.totalInventory ??
            (product.variants?.edges ?? []).reduce(
              (acc, edge) => acc + (edge.node.inventoryQuantity ?? 0),
              0,
            );
          outOfStock = total <= 0;
        }
        const sufficient =
          typeof args.requestedQuantity === 'number'
            ? total >= args.requestedQuantity
            : undefined;
        const out: Record<string, unknown> = {
          totalQuantity: total,
          outOfStock,
        };
        if (sufficient !== undefined) out.sufficient = sufficient;
        return jsonContent(out);
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
