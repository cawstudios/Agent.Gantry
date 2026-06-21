import { LIST_PRODUCTS_FOR_CATALOG } from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';

export interface CatalogProduct {
  handle: string;
  title: string;
  priceMin: string;
  priceMax: string;
  currency: string;
  url: string;
  tags?: string[];
}

export interface ProductCatalogRefreshResult {
  status: 'refreshed' | 'failed';
  count: number;
  error?: string;
}

export class ProductCatalogCache {
  private products: CatalogProduct[] = [];

  replace(products: readonly CatalogProduct[]): void {
    this.products = products.map((product) => ({ ...product }));
  }

  list(): CatalogProduct[] {
    return this.products.map((product) => ({ ...product }));
  }

  async refresh(
    loader: () => Promise<readonly CatalogProduct[]>,
  ): Promise<ProductCatalogRefreshResult> {
    try {
      const products = await loader();
      this.replace(products);
      return { status: 'refreshed', count: products.length };
    } catch (err) {
      return {
        status: 'failed',
        count: this.products.length,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

interface CatalogProductNode {
  handle: string;
  title: string;
  onlineStoreUrl?: string | null;
  tags?: string[] | null;
  priceRangeV2?: {
    minVariantPrice?: { amount: string; currencyCode: string };
    maxVariantPrice?: { amount: string; currencyCode: string };
  } | null;
}

interface CatalogProductsPage {
  products: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor?: string | null;
    };
    edges: Array<{ node: CatalogProductNode }>;
  };
}

function mapCatalogProduct(node: CatalogProductNode): CatalogProduct {
  const priceMin = node.priceRangeV2?.minVariantPrice?.amount ?? '0';
  const priceMax = node.priceRangeV2?.maxVariantPrice?.amount ?? priceMin;
  const currency =
    node.priceRangeV2?.minVariantPrice?.currencyCode ??
    node.priceRangeV2?.maxVariantPrice?.currencyCode ??
    'INR';
  return {
    handle: node.handle,
    title: node.title,
    priceMin,
    priceMax,
    currency,
    url: node.onlineStoreUrl ?? `/products/${node.handle}`,
    tags: node.tags ?? [],
  };
}

export async function loadProductCatalogFromShopify(
  client: ShopifyClient,
  options: { pageSize?: number } = {},
): Promise<CatalogProduct[]> {
  const pageSize = options.pageSize ?? 250;
  const products: CatalogProduct[] = [];
  let after: string | null | undefined;
  do {
    const page = await client.graphql<CatalogProductsPage>(
      LIST_PRODUCTS_FOR_CATALOG,
      {
        query: 'status:active',
        first: pageSize,
        after,
      },
    );
    products.push(
      ...(page.products?.edges ?? []).map((edge) =>
        mapCatalogProduct(edge.node),
      ),
    );
    after = page.products?.pageInfo?.hasNextPage
      ? page.products.pageInfo.endCursor
      : null;
  } while (after);
  return products;
}
