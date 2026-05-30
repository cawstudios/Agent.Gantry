export interface ShopifyCustomer {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

export interface ShopifyMoney {
  amount: string;
  currencyCode: string;
}

export interface ShopifyAddress {
  city?: string | null;
  province?: string | null;
  country?: string | null;
  zip?: string | null;
}

export interface ShopifyLineItem {
  title: string;
  quantity: number;
  sku?: string | null;
}

export interface ShopifyFulfillment {
  trackingUrl?: string | null;
  trackingCompany?: string | null;
  trackingNumber?: string | null;
  estimatedDeliveryAt?: string | null;
  status: string;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  fulfillments: ShopifyFulfillment[];
  lineItems: ShopifyLineItem[];
  totalPriceSet: ShopifyMoney;
  shippingAddress?: ShopifyAddress | null;
  createdAt: string;
  dispatchedAt?: string | null;
  customerId: string | null;
  customer?: ShopifyCustomer;
  discountCodes: string[];
}

export interface OrderSummary {
  id: string;
  name: string;
  status: string;
  financialStatus: string;
  fulfillmentStatus: string;
  courierName?: string | null;
  createdAt: string;
}

export interface ShopifyProductImage {
  url: string;
  altText?: string | null;
}

export interface ShopifyPriceRange {
  minVariantPrice: string;
  maxVariantPrice: string;
  currencyCode: string;
}

export interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  description?: string | null;
  onlineStoreUrl?: string | null;
  priceRange: ShopifyPriceRange;
  available: boolean;
  tags: string[];
  images: ShopifyProductImage[];
}

export interface ShopifyInventoryLevel {
  totalQuantity: number;
  outOfStock: boolean;
}

export interface ShopifyDiscountCode {
  exists: boolean;
  active: boolean;
  minimumOrderAmount?: number | null;
  appliesTo?: 'ALL' | 'COLLECTION' | 'PRODUCT';
  expiresAt?: string | null;
  reason?: string | null;
}
