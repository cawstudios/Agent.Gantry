import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GET_PRODUCT_BY_HANDLE,
  GET_PRODUCT_BY_ID,
} from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import { jsonContent, mapProductResponse, toolErrorContent } from './shared.js';

const inputSchema = {
  handleOrId: z
    .string()
    .min(1)
    .describe('Product handle (e.g. "kaju-katli") or full GID'),
};

interface ProductByHandleResponse {
  productByHandle:
    | (Parameters<typeof mapProductResponse>[0] & { __typename?: string })
    | null;
}

interface ProductByIdResponse {
  product: Parameters<typeof mapProductResponse>[0] | null;
}

export function registerGetProduct(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    'get_product',
    'Read a single product by handle or GID. Returns null when not found.',
    inputSchema,
    async (args) => {
      try {
        if (args.handleOrId.startsWith('gid://')) {
          const data = await client.graphql<ProductByIdResponse>(
            GET_PRODUCT_BY_ID,
            { id: args.handleOrId },
          );
          if (!data.product) return jsonContent({ product: null });
          return jsonContent({ product: mapProductResponse(data.product) });
        }
        const data = await client.graphql<ProductByHandleResponse>(
          GET_PRODUCT_BY_HANDLE,
          { handle: args.handleOrId },
        );
        if (!data.productByHandle) return jsonContent({ product: null });
        return jsonContent({
          product: mapProductResponse(data.productByHandle),
        });
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
