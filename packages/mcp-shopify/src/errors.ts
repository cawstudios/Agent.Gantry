export type ShopifyErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PRIVACY_GUARD_FAILED'
  | 'SCOPE_MISSING'
  | 'ACCESS_DENIED'
  | 'PROTECTED_DATA_REDACTED'
  | 'INTERNAL_ERROR';

export class ShopifyAdapterError extends Error {
  public readonly code: ShopifyErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ShopifyErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ShopifyAdapterError';
    this.code = code;
    this.details = details;
  }
}

export function isShopifyAdapterError(
  value: unknown,
): value is ShopifyAdapterError {
  return value instanceof ShopifyAdapterError;
}
