export interface CustomerIdentityCacheEntry {
  customerId: string;
  matchedVia: 'phone' | 'email';
  expiresAt: number;
}

export interface CustomerIdentityCacheOptions {
  ttlMs: number;
  now?: () => number;
  maxEntries?: number;
}

interface IdentityShape {
  phone?: string;
  email?: string;
}

/**
 * In-memory cache mapping a verified caller identity (phone/email) to the
 * Shopify customer ID Shopify resolved it to. Eliminates the per-request
 * identity-lookup round-trip for tools that need ownership verification
 * (list_orders_for_customer, get_order_history).
 *
 * Safety properties:
 * - Key is the *verified* identity (post-normalization). An attacker cannot
 *   poison the cache because they have to first authenticate (via the channel
 *   adapter HMAC header or arg-mode lookup); the cached value is whatever
 *   Shopify says for that identity at write time.
 * - TTL bounds the staleness window if a customer's phone/email is changed in
 *   Shopify after the cache write.
 */
export class CustomerIdentityCache {
  private readonly map = new Map<string, CustomerIdentityCacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(opts: CustomerIdentityCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? (() => Date.now());
    this.maxEntries = opts.maxEntries ?? 50_000;
  }

  get(identity: IdentityShape): CustomerIdentityCacheEntry | undefined {
    const key = this.keyFor(identity);
    if (!key) return undefined;
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry;
  }

  set(
    identity: IdentityShape,
    customerId: string,
    matchedVia: 'phone' | 'email',
  ): void {
    const key = this.keyFor(identity);
    if (!key) return;
    if (this.map.size >= this.maxEntries) {
      this.evictOldest();
    }
    this.map.set(key, {
      customerId,
      matchedVia,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  invalidate(identity: IdentityShape): void {
    const key = this.keyFor(identity);
    if (key) this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }

  private keyFor(identity: IdentityShape): string | null {
    if (!identity.phone && !identity.email) return null;
    return `${identity.phone ?? ''}|${(identity.email ?? '').toLowerCase()}`;
  }

  private evictOldest(): void {
    // Map preserves insertion order — drop the first entry as a best-effort
    // LRU-ish eviction. Fine for the load profile (1k concurrent callers).
    const firstKey = this.map.keys().next().value;
    if (firstKey !== undefined) this.map.delete(firstKey);
  }
}
