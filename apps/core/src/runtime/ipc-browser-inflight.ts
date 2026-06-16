// Shared browser in-flight accounting.
//
// The socket browser dispatcher draws on this one counter so the global cap of
// 4 concurrent browser IPC requests is enforced across all socket connections.
//
// Browser concurrency is intentionally a small numeric counter (not a keyed Set
// like the interaction cap): the original watcher gated purely on a count, with
// no per-request duplicate guard, so we preserve that exact semantics.

/** Max concurrent in-flight browser IPC requests across all carriers. */
export const MAX_IN_FLIGHT_BROWSER_IPC = 4;

let inFlightBrowserIpc = 0;

/**
 * Try to admit a browser request under the global concurrency cap. Returns true
 * and increments the counter on success (the caller MUST call
 * releaseBrowserInFlight when the handler settles); returns false when the cap
 * is already reached.
 */
export function tryAcquireBrowserInFlight(): boolean {
  if (inFlightBrowserIpc >= MAX_IN_FLIGHT_BROWSER_IPC) return false;
  inFlightBrowserIpc += 1;
  return true;
}

export function releaseBrowserInFlight(): void {
  if (inFlightBrowserIpc > 0) inFlightBrowserIpc -= 1;
}

export function browserInFlightCount(): number {
  return inFlightBrowserIpc;
}

export function clearBrowserInFlight(): void {
  inFlightBrowserIpc = 0;
}
