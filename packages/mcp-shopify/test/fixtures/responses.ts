import type { MockCustomer } from './customers.js';
import { buildOrderNode, type MockOrderInput } from './orders.js';
import { buildProductNode, type MockProductInput } from './products.js';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function tokenResponse(token = 'shpat_test_token', expiresIn = 86_399) {
  return jsonResponse({
    access_token: token,
    scope: 'read_products,read_orders,read_customers',
    expires_in: expiresIn,
  });
}

export function graphqlOk<T>(data: T) {
  return jsonResponse({ data });
}

export function graphqlErrors(errors: Array<{ message: string }>) {
  return jsonResponse({ errors });
}

export function customersEdges(customers: MockCustomer[]) {
  return {
    customers: {
      edges: customers.map((customer) => ({ node: customer })),
    },
  };
}

export function ordersEdges(orders: MockOrderInput[]) {
  return {
    orders: {
      edges: orders.map((order) => ({ node: buildOrderNode(order) })),
    },
  };
}

export function productsEdges(products: MockProductInput[]) {
  return {
    products: {
      edges: products.map((product) => ({ node: buildProductNode(product) })),
    },
  };
}

export function productByHandle(product: MockProductInput) {
  return { productByHandle: buildProductNode(product) };
}

export function emptyProductByHandle() {
  return { productByHandle: null };
}

export function variantInventory(quantity: number, available = quantity > 0) {
  return {
    productVariant: {
      id: 'gid://shopify/ProductVariant/9999',
      inventoryQuantity: quantity,
      availableForSale: available,
    },
  };
}

export function productInventoryByHandle(
  product: MockProductInput,
  variants: Array<{ id: string; inventoryQuantity: number }>,
) {
  return {
    productByHandle: {
      id: buildProductNode(product).id,
      totalInventory: variants.reduce((acc, v) => acc + v.inventoryQuantity, 0),
      variants: {
        edges: variants.map((v) => ({
          node: {
            id: v.id,
            inventoryQuantity: v.inventoryQuantity,
            availableForSale: v.inventoryQuantity > 0,
          },
        })),
      },
    },
  };
}

export function discountNodes(
  matches: Array<{
    title: string;
    status?: 'ACTIVE' | 'EXPIRED' | 'SCHEDULED';
    minimumOrderAmount?: string;
    endsAt?: string | null;
    appliesTo?: 'AllDiscountItems' | 'DiscountCollections' | 'DiscountProducts';
  }>,
) {
  return {
    codeDiscountNodes: {
      edges: matches.map((m, i) => ({
        node: {
          id: `gid://shopify/DiscountCodeNode/${i}`,
          codeDiscount: {
            __typename: 'DiscountCodeBasic',
            title: m.title,
            status: m.status ?? 'ACTIVE',
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: m.endsAt ?? null,
            minimumRequirement: m.minimumOrderAmount
              ? {
                  greaterThanOrEqualToSubtotal: {
                    amount: m.minimumOrderAmount,
                    currencyCode: 'INR',
                  },
                }
              : null,
            customerGets: {
              items: { __typename: m.appliesTo ?? 'AllDiscountItems' },
            },
          },
        },
      })),
    },
  };
}
