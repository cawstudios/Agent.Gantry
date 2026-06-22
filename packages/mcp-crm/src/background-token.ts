// The "token seam" for background isolation. A dedicated background token
// (GANTRY_BACKGROUND_ANTHROPIC_TOKEN in ~/gantry/.env) WINS so production can
// isolate the background (CRM extraction) rate budget from the live customer
// token. When unset, the caller falls back to the shared Gantry Credential Center
// token — the same token in dev. This is the single explicit place to point
// background work at its own key later; today it is just a switch.
export const BACKGROUND_TOKEN_ENV = 'GANTRY_BACKGROUND_ANTHROPIC_TOKEN';

export type BackgroundTokenSource =
  | 'background_env'
  | 'gantry_credential_center';

export interface BackgroundTokenResolution {
  source: BackgroundTokenSource;
  // Only set when source === 'background_env'.
  token?: string;
}

export function resolveBackgroundToken(
  source: NodeJS.ProcessEnv = process.env,
): BackgroundTokenResolution {
  const token = source[BACKGROUND_TOKEN_ENV]?.trim();
  if (token) return { source: 'background_env', token };
  return { source: 'gantry_credential_center' };
}
