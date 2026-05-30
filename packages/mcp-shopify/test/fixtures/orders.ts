import type { MockCustomer } from './customers.js';

export interface MockOrderInput {
  id?: string;
  name: string;
  financial?: string;
  fulfillment?: string;
  createdAt?: string;
  processedAt?: string | null;
  customer: MockCustomer;
  totalAmount?: string;
  currency?: string;
  shippingCity?: string;
  trackingUrl?: string | null;
  trackingCompany?: string | null;
  trackingNumber?: string | null;
  estimatedDeliveryAt?: string | null;
  fulfillmentStatus?: string;
  lineItems?: Array<{ title: string; quantity: number; sku?: string }>;
  discountCodes?: string[];
}

export function buildOrderNode(input: MockOrderInput) {
  const fulfillment = input.fulfillment ?? 'IN_TRANSIT';
  const fulfillmentStatus =
    input.fulfillmentStatus ??
    (fulfillment === 'DELIVERED' || fulfillment === 'FULFILLED'
      ? 'SUCCESS'
      : 'OPEN');
  return {
    id: input.id ?? 'gid://shopify/Order/1',
    name: input.name.startsWith('#') ? input.name : `#${input.name}`,
    displayFinancialStatus: input.financial ?? 'PAID',
    displayFulfillmentStatus: fulfillment,
    createdAt: input.createdAt ?? '2026-05-15T08:30:00Z',
    processedAt: input.processedAt ?? '2026-05-15T08:35:00Z',
    cancelledAt: null,
    totalPriceSet: {
      shopMoney: {
        amount: input.totalAmount ?? '1200.00',
        currencyCode: input.currency ?? 'INR',
      },
    },
    discountCodes: input.discountCodes ?? [],
    customer: {
      id: input.customer.id,
      firstName: input.customer.firstName,
      lastName: input.customer.lastName,
      email: input.customer.email,
      phone: input.customer.phone,
    },
    shippingAddress: {
      city: input.shippingCity ?? 'Mumbai',
      province: 'Maharashtra',
      country: 'India',
      zip: '400050',
    },
    lineItems: {
      edges: (input.lineItems ?? [{ title: 'Kaju Katli Box', quantity: 3 }]).map(
        (item) => ({
          node: {
            title: item.title,
            quantity: item.quantity,
            sku: item.sku ?? null,
          },
        }),
      ),
    },
    fulfillments: [
      {
        status: fulfillmentStatus,
        estimatedDeliveryAt: input.estimatedDeliveryAt ?? '2026-05-18T18:00:00Z',
        trackingInfo: [
          {
            url: input.trackingUrl ?? 'https://shipping.example.com/track/abc',
            company: input.trackingCompany ?? 'BlueDart',
            number: input.trackingNumber ?? 'BD1234567IN',
          },
        ],
      },
    ],
  };
}
