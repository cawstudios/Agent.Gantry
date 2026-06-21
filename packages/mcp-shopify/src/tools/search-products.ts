import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShopifyClient } from '../shopify/client.js';
import { jsonContent, toolErrorContent } from './shared.js';
import type {
  CatalogProduct,
  ProductCatalogCache,
} from './product-catalog-cache.js';
import type { ProductSearchCache } from './product-search-cache.js';

const inputSchema = {
  query: z.string().optional(),
  tag: z.string().optional(),
  status: z.enum(['ACTIVE', 'DRAFT', 'ARCHIVED']).optional(),
  priceMin: z.number().nonnegative().optional(),
  priceMax: z.number().nonnegative().optional(),
  maxPrice: z
    .number()
    .nonnegative()
    .optional()
    .describe('Compatibility alias for priceMax. Prefer priceMax.'),
  limit: z.number().int().min(1).max(50).optional(),
};

export type LeanProductSearchSummary = Pick<
  CatalogProduct,
  'title' | 'priceMin' | 'priceMax' | 'currency' | 'url'
>;

function isGiftProductSearch(args: { query?: string; tag?: string }): boolean {
  const text = `${args.query ?? ''} ${args.tag ?? ''}`.toLowerCase();
  return /\b(gift|gifting|birthday|present|hamper)\b/.test(text);
}

function isBulkOrEventGiftSearch(args: {
  query?: string;
  tag?: string;
}): boolean {
  const text = `${args.query ?? ''} ${args.tag ?? ''}`.toLowerCase();
  return /\b(bulk|corporate|client|clients|employee|employees|guest|guests|wedding|gst|logo|branding|quote|procurement|multi-city|pan-india)\b/.test(
    text,
  );
}

export function compactCatalogProductSearchSummary(
  product: CatalogProduct,
): LeanProductSearchSummary {
  return {
    title: product.title,
    priceMin: product.priceMin,
    priceMax: product.priceMax,
    currency: product.currency,
    url: product.url,
  };
}

function isAccessoryOnlyProduct(product: CatalogProduct): boolean {
  const text = `${product.handle} ${product.title}`.toLowerCase();
  return /\b(gift[- ]?bag|bag|wrapping|wrap|gift[- ]?wrap|sleeve)\b/.test(text);
}

function searchableText(product: CatalogProduct): string {
  return [product.handle, product.title, ...(product.tags ?? [])]
    .join(' ')
    .toLowerCase();
}

const QUERY_STOP_WORDS = new Set([
  'a',
  'all',
  'and',
  'below',
  'budget',
  'buy',
  'for',
  'gift',
  'gifting',
  'i',
  'list',
  'need',
  'options',
  'present',
  'recommend',
  'show',
  'suggest',
  'under',
  'what',
]);

function inferPriceMaxFromQuery(query: string | undefined): number | undefined {
  if (!query) return undefined;
  const match =
    /\b(?:under|below|upto|up\s*to|less\s+than)\s*(?:rs\.?|₹|inr)?\s*([0-9][0-9,]*)\b/i.exec(
      query,
    );
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1]!.replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function queryTokens(query: string | undefined): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length > 1 &&
        !/^[0-9]+$/.test(token) &&
        !QUERY_STOP_WORDS.has(token),
    );
}

function normalizedQuery(query: string | undefined): string {
  return query
    ? query
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
    : '';
}

function titleHandleText(product: CatalogProduct): string {
  return `${product.title} ${product.handle}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function catalogProductScore(
  product: CatalogProduct,
  query: string | undefined,
  tokens: readonly string[],
): number {
  const phrase = normalizedQuery(query);
  if (!phrase || tokens.length < 2) return 0;
  const titleHandle = titleHandleText(product);
  const text = searchableText(product);
  let score = 0;
  if (phrase && titleHandle.includes(phrase)) score += 100;
  if (phrase && text.includes(phrase)) score += 50;
  for (const token of tokens) {
    if (titleHandle.includes(token)) score += 10;
    else if (text.includes(token)) score += 3;
  }
  return score;
}

function productPriceMin(product: CatalogProduct): number {
  return Number.parseFloat(product.priceMin);
}

function productPriceMax(product: CatalogProduct): number {
  return Number.parseFloat(product.priceMax);
}

function filterCatalogProducts(
  products: readonly CatalogProduct[],
  args: {
    query?: string;
    tag?: string;
    priceMin?: number;
    priceMax?: number;
    rank?: boolean;
  },
): CatalogProduct[] {
  const tokens = queryTokens(args.query);
  const tag = args.tag?.trim().toLowerCase();
  return products
    .map((product, index) => ({ product, index }))
    .filter(({ product }) => {
      const text = searchableText(product);
      if (
        tag &&
        !(product.tags ?? []).some((item) => item.toLowerCase() === tag)
      ) {
        return false;
      }
      if (tokens.length > 0 && !tokens.some((token) => text.includes(token))) {
        return false;
      }
      if (
        typeof args.priceMin === 'number' &&
        productPriceMin(product) < args.priceMin
      ) {
        return false;
      }
      if (
        typeof args.priceMax === 'number' &&
        productPriceMax(product) > args.priceMax
      ) {
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      if (args.rank === false) return left.index - right.index;
      const scoreDelta =
        catalogProductScore(right.product, args.query, tokens) -
        catalogProductScore(left.product, args.query, tokens);
      return scoreDelta || left.index - right.index;
    })
    .map(({ product }) => product);
}

function priceOnlyCatalogProducts(
  products: readonly CatalogProduct[],
  args: { priceMin?: number; priceMax?: number },
): CatalogProduct[] {
  return products.filter((product) => {
    if (
      typeof args.priceMin === 'number' &&
      productPriceMin(product) < args.priceMin
    ) {
      return false;
    }
    if (
      typeof args.priceMax === 'number' &&
      productPriceMax(product) > args.priceMax
    ) {
      return false;
    }
    return true;
  });
}

export function registerSearchProducts(
  server: McpServer,
  _client: ShopifyClient,
  options: {
    productCatalogCache?: ProductCatalogCache;
    productSearchCache?: ProductSearchCache;
  } = {},
): void {
  server.tool(
    'search_products',
    'Search the locally cached store catalogue by one targeted query, tag, status, or price band. Make at most one targeted search per customer turn; if the result is not enough, ask or route instead of searching again. Returns lean product summaries and never performs a live Shopify lookup during the customer turn. Do not use for dietary, allergen, Jain, sugar-free, diabetic-friendly, ingredient, or medical-suitability answers.',
    inputSchema,
    async (args) => {
      const limit = args.limit ?? 3;
      const priceMax =
        args.priceMax ?? args.maxPrice ?? inferPriceMaxFromQuery(args.query);
      try {
        const products = options.productCatalogCache?.list() ?? [];
        const personalGiftSearch =
          isGiftProductSearch(args) && !isBulkOrEventGiftSearch(args);
        const filtered = filterCatalogProducts(products, {
          query: args.query,
          tag: args.tag,
          priceMin: args.priceMin,
          priceMax,
          rank: !personalGiftSearch,
        });
        const nonAccessoryProducts = filtered.filter(
          (product) => !isAccessoryOnlyProduct(product),
        );
        const fallbackGiftProducts =
          personalGiftSearch && nonAccessoryProducts.length === 0
            ? priceOnlyCatalogProducts(products, {
                priceMin: args.priceMin,
                priceMax,
              }).filter((product) => !isAccessoryOnlyProduct(product))
            : [];
        const responseProducts = personalGiftSearch
          ? (nonAccessoryProducts.length > 0
              ? nonAccessoryProducts
              : fallbackGiftProducts.length > 0
                ? fallbackGiftProducts
                : filtered
            ).slice(0, 3)
          : filtered.slice(0, limit);
        return jsonContent({
          products: responseProducts.map(compactCatalogProductSearchSummary),
        });
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
