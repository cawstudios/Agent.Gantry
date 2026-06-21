import type { ShopifyProduct } from '../shopify/types.js';

export type ProductSearchSummary = Pick<
  ShopifyProduct,
  'id' | 'handle' | 'title' | 'priceRange' | 'available'
>;

export function buildProductQuery(args: {
  query?: string;
  tag?: string;
  status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  priceMin?: number;
  priceMax?: number;
}): string {
  const tokens: string[] = [];
  if (args.query) tokens.push(args.query);
  if (args.tag) tokens.push(`tag:${args.tag}`);
  tokens.push(`status:${(args.status ?? 'ACTIVE').toLowerCase()}`);
  if (typeof args.priceMin === 'number')
    tokens.push(`variants.price:>=${args.priceMin}`);
  if (typeof args.priceMax === 'number')
    tokens.push(`variants.price:<=${args.priceMax}`);
  return tokens.join(' ').trim();
}

export function compactProductSearchSummary(
  product: ShopifyProduct,
): ProductSearchSummary {
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    priceRange: product.priceRange,
    available: product.available,
  };
}
