export interface MockProductInput {
  id?: string;
  handle: string;
  title: string;
  description?: string;
  onlineStoreUrl?: string;
  totalInventory?: number;
  tags?: string[];
  minPrice?: string;
  maxPrice?: string;
  currency?: string;
}

export function buildProductNode(input: MockProductInput) {
  const min = input.minPrice ?? '600.00';
  const max = input.maxPrice ?? min;
  return {
    id: input.id ?? `gid://shopify/Product/${input.handle}`,
    handle: input.handle,
    title: input.title,
    description: input.description ?? '',
    onlineStoreUrl:
      input.onlineStoreUrl ?? `https://shop.example.com/products/${input.handle}`,
    tags: input.tags ?? [],
    totalInventory: input.totalInventory ?? 25,
    priceRangeV2: {
      minVariantPrice: { amount: min, currencyCode: input.currency ?? 'INR' },
      maxVariantPrice: { amount: max, currencyCode: input.currency ?? 'INR' },
    },
    featuredImage: {
      url: `https://cdn.example.com/${input.handle}.jpg`,
      altText: input.title,
    },
    images: { edges: [] as Array<{ node: { url: string; altText?: string } }> },
  };
}
