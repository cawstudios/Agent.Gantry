// Environment for the boondi-crm MCP server. Mirrors mcp-shopify/src/env.ts in
// shape (typed config, fail-fast on missing required values). The identity
// SECRET is shared with the runtime (SHOPIFY_MCP_IDENTITY_SECRET) so the signed
// X-Caller-Identity verifies here exactly as it does for Shopify; everything
// else is boondi-crm-specific (its own port, DB url, reconciler cadence).

export type IdentityConfig =
  | { mode: 'disabled' }
  | { mode: 'optional'; secret: string; maxAgeSec: number }
  | { mode: 'required'; secret: string; maxAgeSec: number };

export interface BoondiCrmEnv {
  port: number;
  databaseUrl: string;
  dbSchema: string;
  identity: IdentityConfig;
  requireVerifiedIdentity: boolean;
  identityMaxAgeSec: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  logFormat: 'json' | 'text';
  // Reconciler (durable backstop) — used from Phase 4 onward.
  reconcileEnabled: boolean;
  reconcileIntervalMs: number;
  reconcileIdleMinutes: number;
  reconcileLookbackHours: number;
  reconcileAgentId: string;
  reconcileModel: string;
  anthropicApiKey?: string;
}

const VALID_LOG_LEVELS = new Set([
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const);

type LogLevel = BoondiCrmEnv['logLevel'];

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return value;
}

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (!raw) return 'info';
  const lower = raw.toLowerCase();
  if (!VALID_LOG_LEVELS.has(lower as LogLevel)) {
    throw new Error(
      `Invalid LOG_LEVEL: ${raw} (allowed: ${[...VALID_LOG_LEVELS].join(', ')})`,
    );
  }
  return lower as LogLevel;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

function parseIdentity(source: NodeJS.ProcessEnv): IdentityConfig {
  // The signing secret is the runtime's identity key (shared with mcp-shopify).
  const secret = source.SHOPIFY_MCP_IDENTITY_SECRET?.trim() ?? '';
  const require = parseBool(
    source.BOONDI_CRM_REQUIRE_VERIFIED_IDENTITY,
    true,
  );
  const maxAgeSec = parsePositiveInt(
    'BOONDI_CRM_IDENTITY_MAX_AGE_SEC',
    source.BOONDI_CRM_IDENTITY_MAX_AGE_SEC,
    120,
  );

  if (require) {
    if (!secret) {
      throw new Error(
        'BOONDI_CRM_REQUIRE_VERIFIED_IDENTITY=true requires SHOPIFY_MCP_IDENTITY_SECRET to be set',
      );
    }
    return { mode: 'required', secret, maxAgeSec };
  }
  if (secret) return { mode: 'optional', secret, maxAgeSec };
  return { mode: 'disabled' };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): BoondiCrmEnv {
  const identity = parseIdentity(source);
  return {
    port: parsePort(source.BOONDI_CRM_MCP_PORT, 8082),
    databaseUrl: required(
      'BOONDI_CRM_DATABASE_URL',
      source.BOONDI_CRM_DATABASE_URL ?? source.GANTRY_DATABASE_URL,
    ),
    dbSchema: source.BOONDI_CRM_DB_SCHEMA?.trim() || 'gantry',
    identity,
    requireVerifiedIdentity: identity.mode === 'required',
    identityMaxAgeSec: identity.mode === 'disabled' ? 120 : identity.maxAgeSec,
    logLevel: parseLogLevel(source.LOG_LEVEL),
    logFormat: source.LOG_FORMAT === 'text' ? 'text' : 'json',
    reconcileEnabled: parseBool(source.BOONDI_CRM_RECONCILE_ENABLED, true),
    reconcileIntervalMs: parsePositiveInt(
      'BOONDI_CRM_RECONCILE_INTERVAL_MS',
      source.BOONDI_CRM_RECONCILE_INTERVAL_MS,
      240_000,
    ),
    reconcileIdleMinutes: parsePositiveInt(
      'BOONDI_CRM_RECONCILE_IDLE_MIN',
      source.BOONDI_CRM_RECONCILE_IDLE_MIN,
      10,
    ),
    reconcileLookbackHours: parsePositiveInt(
      'BOONDI_CRM_RECONCILE_LOOKBACK_HOURS',
      source.BOONDI_CRM_RECONCILE_LOOKBACK_HOURS,
      48,
    ),
    reconcileAgentId:
      source.BOONDI_CRM_AGENT_ID?.trim() || 'agent:boondi_support',
    reconcileModel:
      source.BOONDI_CRM_RECONCILE_MODEL?.trim() ||
      'claude-haiku-4-5-20251001',
    anthropicApiKey: source.ANTHROPIC_API_KEY?.trim() || undefined,
  };
}
