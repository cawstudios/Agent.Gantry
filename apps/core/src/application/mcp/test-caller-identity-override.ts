// DEV/TESTING ONLY. When GANTRY_TEST_CALLER_IDENTITY_PHONE is set, the MCP
// caller identity (the JID used to sign the X-Caller-Identity header) is remapped
// to that phone, so Shopify queries resolve against a test customer that actually
// has data — while WhatsApp/conversation routing keeps the real number. When
// unset, the real Interakt conversation number is passed through to the MCP.
//
// INDEPENDENT dev flag: controlled solely by GANTRY_TEST_CALLER_IDENTITY_PHONE,
// NOT scoped by GANTRY_TEST_OPERATOR_PHONE. While set on a server with live
// traffic it would swap EVERY caller's identity, so keep it unset except on a
// dev/test instance. Unset in production => no-op.
const TEST_PHONE_ENV = 'GANTRY_TEST_CALLER_IDENTITY_PHONE';
const TEST_MCP_SERVERS_ENV = 'GANTRY_TEST_CALLER_IDENTITY_MCP_SERVERS';
const DEFAULT_TEST_MCP_SERVERS = ['shopify-api'];

function configuredOverrideServers(): Set<string> {
  const raw = process.env[TEST_MCP_SERVERS_ENV]?.trim();
  const values = raw
    ? raw.split(/[\s,]+/).filter(Boolean)
    : DEFAULT_TEST_MCP_SERVERS;
  return new Set(values);
}

export function applyTestCallerIdentityOverride(
  jid: string,
  opts: { serverName?: string } = {},
): string {
  const testPhone = process.env[TEST_PHONE_ENV]?.trim();
  if (!testPhone) return jid;
  if (opts.serverName && !configuredOverrideServers().has(opts.serverName)) {
    return jid;
  }
  // Preserve the channel prefix (e.g. "wa:") and swap only the numeric suffix.
  const match = jid.match(/^(.*?)(\d+)$/);
  return match ? `${match[1]}${testPhone}` : jid;
}
