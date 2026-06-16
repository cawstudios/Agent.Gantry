import { ShopifyAdapterError } from '../errors.js';
import { withExponentialBackoff } from '../retry.js';
import type { TokenManager } from '../auth/token-manager.js';
import type { Logger } from '../logger.js';

export interface ShopifyClientOptions {
  shopDomain: string;
  apiVersion: string;
  tokenManager: TokenManager;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  graphqlTimeoutMs?: number;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: Record<string, unknown>;
    path?: Array<string | number>;
  }>;
  extensions?: Record<string, unknown>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY = 250;
const DEFAULT_MAX_DELAY = 8000;
const DEFAULT_GRAPHQL_TIMEOUT_MS = 8000;

const SCOPE_MISSING_HINTS = [
  'missing scope',
  'read_all_orders',
  'requires merchant approval',
];

const PCD_HINTS = [
  'protected customer data',
  'protected-customer-data',
  'protected_customer_data',
  'not approved to access the customer',
  'not approved to access customer',
];

const ACCESS_DENIED_CODES = new Set(['ACCESS_DENIED', 'FORBIDDEN']);

export class ShopifyClient {
  private readonly shopDomain: string;
  private readonly apiVersion: string;
  private readonly tokenManager: TokenManager;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Logger;
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly graphqlTimeoutMs: number;

  constructor(opts: ShopifyClientOptions) {
    this.shopDomain = opts.shopDomain;
    this.apiVersion = opts.apiVersion;
    this.tokenManager = opts.tokenManager;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY;
    this.graphqlTimeoutMs =
      opts.graphqlTimeoutMs ?? DEFAULT_GRAPHQL_TIMEOUT_MS;
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    return withExponentialBackoff(
      async () => this.executeOnce<T>(query, variables),
      {
        maxAttempts: this.maxAttempts,
        initialDelayMs: this.initialDelayMs,
        maxDelayMs: this.maxDelayMs,
      },
    );
  }

  private async executeOnce<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const url = `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
    const token = await this.tokenManager.getToken();

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.graphqlTimeoutMs);
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ShopifyAdapterError(
          'TIMEOUT',
          `Shopify GraphQL timed out after ${this.graphqlTimeoutMs}ms`,
          { timeoutMs: this.graphqlTimeoutMs },
        );
      }
      throw new ShopifyAdapterError(
        'NETWORK_ERROR',
        `Shopify GraphQL network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401) {
      await this.tokenManager.forceRefresh();
      throw new ShopifyAdapterError(
        'INVALID_CREDENTIALS',
        'Shopify Admin API returned 401 (token forced-refreshed; retry will re-acquire)',
      );
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      throw new ShopifyAdapterError(
        'RATE_LIMITED',
        `Shopify rate limit (429); Retry-After=${retryAfter ?? 'unknown'}`,
        {
          retryAfterMs: retryAfter ? Number.parseFloat(retryAfter) * 1000 : null,
        },
      );
    }

    if (response.status >= 500) {
      throw new ShopifyAdapterError(
        'UNAVAILABLE',
        `Shopify Admin API ${response.status}`,
      );
    }

    if (response.status === 404) {
      throw new ShopifyAdapterError(
        'NOT_FOUND',
        'Shopify Admin API returned 404',
      );
    }

    if (!response.ok) {
      throw new ShopifyAdapterError(
        'INVALID_REQUEST',
        `Shopify Admin API ${response.status}`,
      );
    }

    let payload: GraphQLResponse<T>;
    try {
      payload = (await response.json()) as GraphQLResponse<T>;
    } catch (err) {
      throw new ShopifyAdapterError(
        'INVALID_REQUEST',
        `Shopify response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (payload.errors && payload.errors.length > 0) {
      const messages = payload.errors.map((e) => e.message).join('; ');
      const lower = messages.toLowerCase();
      const accessDenied = payload.errors.some((e) => {
        const code = (e.extensions as { code?: string } | undefined)?.code;
        return typeof code === 'string' && ACCESS_DENIED_CODES.has(code);
      });
      if (PCD_HINTS.some((h) => lower.includes(h))) {
        throw new ShopifyAdapterError(
          'PROTECTED_DATA_REDACTED',
          `Shopify protected customer data not configured: ${messages}`,
          { errors: payload.errors },
        );
      }
      if (SCOPE_MISSING_HINTS.some((h) => lower.includes(h))) {
        throw new ShopifyAdapterError(
          'SCOPE_MISSING',
          `Shopify scope missing: ${messages}`,
          { errors: payload.errors },
        );
      }
      if (accessDenied) {
        throw new ShopifyAdapterError(
          'ACCESS_DENIED',
          `Shopify access denied (app uninstalled, store suspended, IP allowlist, or OAuth revoked): ${messages}`,
          { errors: payload.errors },
        );
      }
      throw new ShopifyAdapterError(
        'INVALID_REQUEST',
        `Shopify GraphQL errors: ${messages}`,
        { errors: payload.errors },
      );
    }

    if (!payload.data) {
      throw new ShopifyAdapterError(
        'INVALID_REQUEST',
        'Shopify GraphQL response had no data',
      );
    }

    this.logger?.debug({ extensions: payload.extensions }, 'shopify_graphql_ok');
    return payload.data;
  }
}
