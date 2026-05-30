import { describe, expect, it } from 'vitest';
import { CustomerIdentityCache } from '../../../src/privacy/customer-identity-cache.js';

describe('CustomerIdentityCache', () => {
  it('returns undefined when the identity is unknown', () => {
    const cache = new CustomerIdentityCache({ ttlMs: 1000 });
    expect(cache.get({ phone: '+919876543210' })).toBeUndefined();
  });

  it('returns undefined when neither phone nor email is supplied', () => {
    const cache = new CustomerIdentityCache({ ttlMs: 1000 });
    cache.set({}, 'gid://shopify/Customer/1', 'phone');
    expect(cache.get({})).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('returns cached entry within the TTL', () => {
    let now = 1_000_000;
    const cache = new CustomerIdentityCache({ ttlMs: 5000, now: () => now });
    cache.set(
      { phone: '+919876543210' },
      'gid://shopify/Customer/123',
      'phone',
    );
    now += 4000;
    const entry = cache.get({ phone: '+919876543210' });
    expect(entry?.customerId).toBe('gid://shopify/Customer/123');
    expect(entry?.matchedVia).toBe('phone');
  });

  it('evicts expired entries on read', () => {
    let now = 1_000_000;
    const cache = new CustomerIdentityCache({ ttlMs: 5000, now: () => now });
    cache.set(
      { phone: '+919876543210' },
      'gid://shopify/Customer/123',
      'phone',
    );
    now += 6000;
    expect(cache.get({ phone: '+919876543210' })).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('keys by phone-and-email combination (different identities are independent)', () => {
    const cache = new CustomerIdentityCache({ ttlMs: 5000 });
    cache.set(
      { phone: '+919876543210' },
      'gid://shopify/Customer/1',
      'phone',
    );
    cache.set(
      { email: 'a@example.com' },
      'gid://shopify/Customer/2',
      'email',
    );
    expect(cache.get({ phone: '+919876543210' })?.customerId).toBe(
      'gid://shopify/Customer/1',
    );
    expect(cache.get({ email: 'a@example.com' })?.customerId).toBe(
      'gid://shopify/Customer/2',
    );
  });

  it('lowercases email before keying', () => {
    const cache = new CustomerIdentityCache({ ttlMs: 5000 });
    cache.set({ email: 'A@EXAMPLE.com' }, 'gid://shopify/Customer/1', 'email');
    expect(cache.get({ email: 'a@example.com' })?.customerId).toBe(
      'gid://shopify/Customer/1',
    );
  });

  it('invalidate() removes a specific identity', () => {
    const cache = new CustomerIdentityCache({ ttlMs: 5000 });
    cache.set(
      { phone: '+919876543210' },
      'gid://shopify/Customer/1',
      'phone',
    );
    cache.invalidate({ phone: '+919876543210' });
    expect(cache.get({ phone: '+919876543210' })).toBeUndefined();
  });

  it('caps entries via best-effort LRU eviction', () => {
    const cache = new CustomerIdentityCache({ ttlMs: 5000, maxEntries: 3 });
    cache.set({ phone: '+91111' }, 'gid://shopify/Customer/1', 'phone');
    cache.set({ phone: '+91222' }, 'gid://shopify/Customer/2', 'phone');
    cache.set({ phone: '+91333' }, 'gid://shopify/Customer/3', 'phone');
    cache.set({ phone: '+91444' }, 'gid://shopify/Customer/4', 'phone');
    expect(cache.size()).toBe(3);
    expect(cache.get({ phone: '+91111' })).toBeUndefined();
    expect(cache.get({ phone: '+91444' })?.customerId).toBe(
      'gid://shopify/Customer/4',
    );
  });
});
