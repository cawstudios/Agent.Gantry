import { DEFAULT_BROWSER_KEEPALIVE_MS } from './browser-config.js';

export function resolveBrowserKeepAliveMs(value: number | undefined): number {
  return Math.max(10_000, value || DEFAULT_BROWSER_KEEPALIVE_MS);
}
