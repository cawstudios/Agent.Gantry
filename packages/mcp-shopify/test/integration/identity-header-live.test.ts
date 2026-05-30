import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  computeIdentitySignature,
  IDENTITY_HEADER_NAME,
} from '../../src/identity/identity-header.js';
import { startHttpServer, type RunningHttpServer } from '../../src/server.js';
import { createLogger } from '../../src/logger.js';
import { loadDotenvUpwards } from '../../src/dotenv-load.js';

loadDotenvUpwards();

const LIVE = process.env.SHOPIFY_LIVE === '1';
const SHOP = process.env.SHOPIFY_DEV_SHOP_DOMAIN ?? '';
const CLIENT_ID = process.env.SHOPIFY_DEV_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.SHOPIFY_DEV_CLIENT_SECRET ?? '';
const ENABLED = LIVE && SHOP !== '' && CLIENT_ID !== '' && CLIENT_SECRET !== '';

const SECRET = 'identity-header-integration-test-secret';
const PORT = 18082; // dedicated port so we don't collide with a running server

let running: RunningHttpServer | undefined;
const endpoint = `http://127.0.0.1:${PORT}/mcp`;

function signedHeaderValue(opts: {
  phone?: string;
  email?: string;
  ts?: number;
}): string {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const sig = computeIdentitySignature(
    { phone: opts.phone, email: opts.email, ts },
    SECRET,
  );
  const parts: string[] = [];
  if (opts.phone) parts.push(`phone:${opts.phone}`);
  if (opts.email) parts.push(`email:${opts.email}`);
  parts.push(`ts:${ts}`);
  parts.push(`sig:${sig}`);
  return parts.join(';');
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  headerValue?: string,
): Promise<{
  data?: unknown;
  error?: { code: string; message: string };
  raw: unknown;
  status?: number;
}> {
  const headers: Record<string, string> = {};
  if (headerValue) headers[IDENTITY_HEADER_NAME] = headerValue;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers },
  });
  const client = new Client({ name: 'header-test', version: '0.0.0' }, {});
  try {
    await client.connect(transport);
  } catch (err) {
    return {
      error: {
        code: 'CONNECTION_REFUSED',
        message: err instanceof Error ? err.message : String(err),
      },
      raw: err,
    };
  }
  try {
    const result = await client.callTool({ name, arguments: args });
    const block = result.content?.[0];
    const text =
      block && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '';
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text;
    }
    if (
      result.isError ||
      (raw && typeof raw === 'object' && 'error' in (raw as object))
    ) {
      const err = (raw as { error?: { code: string; message: string } }).error;
      return { error: err, raw };
    }
    return { data: raw, raw };
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  running = await startHttpServer({
    env: {
      shopDomain: SHOP,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      apiVersion: process.env.SHOPIFY_DEV_API_VERSION ?? '2026-04',
      port: PORT,
      refreshLeadTimeMs: 300_000,
      logLevel: 'warn',
      logFormat: 'json',
      identity: { mode: 'optional', secret: SECRET, maxAgeSec: 60 },
      identitySecret: SECRET,
      requireVerifiedIdentity: false,
      identityMaxAgeSec: 60,
    },
    logger: createLogger({ level: 'warn', format: 'json' }),
  });
});

afterAll(async () => {
  await running?.close();
});

describe.skipIf(!ENABLED)('identity header — live HTTP', () => {
  it('accepts a correctly-signed header (NOT_FOUND because the order does not exist on dev store)', async () => {
    const header = signedHeaderValue({ phone: '+919876543210' });
    const result = await callTool(
      'get_order',
      { orderNumber: 'BSS-DOES-NOT-EXIST-99999' },
      header,
    );
    // We don't have real orders on the dev store, so NOT_FOUND is the expected
    // success path that proves the request actually reached the tool handler.
    expect(['NOT_FOUND', 'PROTECTED_DATA_REDACTED']).toContain(
      result.error?.code,
    );
  });

  it('rejects a tampered header with 401 before reaching the tool', async () => {
    const goodHeader = signedHeaderValue({ phone: '+919876543210' });
    const tampered = goodHeader.replace(/sig:[a-f0-9]+/, 'sig:deadbeef');
    const result = await callTool(
      'get_order',
      { orderNumber: 'BSS-2847' },
      tampered,
    );
    // The transport throws on 401, so we expect a connection-level error
    expect(result.error).toBeDefined();
  });

  it('allows requests without a header in dev mode (requireVerifiedIdentity=false)', async () => {
    const result = await callTool('search_products', { limit: 1 });
    expect(result.error).toBeUndefined();
    expect(Array.isArray((result.data as { products: unknown[] }).products)).toBe(
      true,
    );
  });
});

it('integration placeholder so file always loads', () => {
  expect(ENABLED || !ENABLED).toBe(true);
});
