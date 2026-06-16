export interface WarmPoolEligibilityInput {
  /** Spawn-facing provider session handle. */
  sessionId?: string | null;
  /** Source-facing provider session handle for callers before spawn input exists. */
  externalSessionId?: string | null;
}

export function isPoolEligible(input: WarmPoolEligibilityInput): boolean {
  void input;
  return true;
}
