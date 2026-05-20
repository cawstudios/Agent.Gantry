import { AsyncLocalStorage } from 'node:async_hooks';
import type { VerifiedIdentity } from './identity-header.js';

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
