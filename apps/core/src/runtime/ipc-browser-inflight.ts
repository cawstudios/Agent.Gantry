// Shared browser in-flight accounting.
//
// Both the fs watcher (runtime/ipc-browser-requests.ts) and the socket server's
// browser dispatcher draw on this ONE counter so the global cap of 4 concurrent
// browser IPC requests is enforced regardless of which transport a request
// arrived on. Promoting it out of ipc-browser-requests.ts (where it used to be a
// private module-level number) keeps the socket path from launching a 5th
// concurrent browser action while the fs path already holds 4 (and vice-versa).
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
 * is already reached (mirrors the watcher's `inFlightBrowserIpc >= MAX` throw).
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
