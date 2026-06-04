import { AsyncLocalStorage } from 'node:async_hooks';
import type { VerifiedIdentity } from './identity-header.js';

// Per-request verified identity, so tool handlers read the caller phone without
// it being passed in args (defence-in-depth: a phone in args is never trusted).
const store = new AsyncLocalStorage<VerifiedIdentity | null>();

export function runWithIdentity<T>(
  identity: VerifiedIdentity | null,
  fn: () => Promise<T>,
): Promise<T> {
  return store.run(identity, fn);
}

export function getVerifiedIdentity(): VerifiedIdentity | null {
  return store.getStore() ?? null;
}
