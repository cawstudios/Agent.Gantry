// Self-contained agent-declared command. Like `guardrails/guardrail.ts`, it has
// NO import dependency on Gantry core: the context type is declared locally and
// the module is loaded by core's command-registry, which validates the exported
// shape `{ name, description, visibility, run }`. The heavy work and credentials
// live in the Boondi CRM service (mcp-crm); run() is a thin HMAC-signed HTTP call
// to its /admin/extract-leads-queries endpoint.
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Channel-neutral envelope core passes to run(). Mirrors core's
// AgentCommandContext; declared here to keep the module self-contained.
interface AgentCommandContext {
  conversationId: string;
  conversationJid: string;
  threadId: string | null;
}

interface LeadQueryExtractionStats {
  extracted: number;
  created: number;
  updated: number;
  skipped: number;
}

// Core's process does not hydrate ~/gantry/.env into process.env (only the
// mcp-crm service loads that file itself), so this self-contained module
// resolves its own settings the way the ops scripts do (scripts/lib/
// runtime-env.mjs): process.env first, then the runtime env file under
// GANTRY_HOME. Without this, production runs send no identity header and the
// CRM's admin route (verified-identity required) rejects them with 401.
function runtimeEnv(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const home = process.env.GANTRY_HOME || path.join(os.homedir(), 'gantry');
  try {
    const text = fs.readFileSync(path.join(home, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && match[1] === name) {
        let value = match[2];
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return value || undefined;
      }
    }
  } catch {
    // No runtime env file — fall through.
  }
  return undefined;
}

function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function endpointFromEnv(): string {
  const configured = runtimeEnv('BOONDI_CRM_MCP_URL');
  if (configured) {
    const parsed = new URL(configured);
    parsed.pathname = '/admin/extract-leads-queries';
    parsed.search = '';
    return parsed.toString();
  }
  const port = runtimeEnv('BOONDI_CRM_MCP_PORT') || '8082';
  return `http://127.0.0.1:${port}/admin/extract-leads-queries`;
}

// Boondi runs on WhatsApp; the operator phone is the conversation identity the
// CRM service authorises against. Deriving it here (not in core) is the whole
// point of the channel-neutral context — core never parses a channel's JID.
function phoneFromConversationId(conversationId: string): string {
  const match = conversationId.match(/^conversation:wa:(\d+)$/);
  if (!match) {
    throw new Error(
      '/extract-leads-queries is available only in conversation:wa:<digits> conversations.',
    );
  }
  return match[1];
}

function identityHeader(phone: string): string | undefined {
  const secret = runtimeEnv('MCP_IDENTITY_SECRET');
  if (!secret) return undefined;
  const ts = Math.floor(Date.now() / 1000);
  const sig = hmacSha256Hex(
    secret,
    [`phone=${phone}`, 'email=', `ts=${ts}`].join('|'),
  );
  return `phone:${phone};ts:${ts};sig:${sig}`;
}

function parseStats(value: unknown): LeadQueryExtractionStats {
  const stats = (value as { stats?: Partial<LeadQueryExtractionStats> })?.stats;
  const count = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    extracted: count(stats?.extracted),
    created: count(stats?.created),
    updated: count(stats?.updated),
    skipped: count(stats?.skipped),
  };
}

export const command = {
  name: 'extract-leads-queries',
  description: 'Extract CRM lead/query candidates from this conversation.',
  visibility: 'operator' as const,
  ackOnStart: 'Running lead/query extraction…',
  // Above mcp-crm's extraction LLM budget (120s) so a slow-but-successful run
  // is not reported "timed out" while its stats reply is dropped.
  timeoutMs: 150_000,
  async run(ctx: AgentCommandContext): Promise<string> {
    const phone = phoneFromConversationId(ctx.conversationId);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const identity = identityHeader(phone);
    if (identity) headers['X-Caller-Identity'] = identity;
    const res = await fetch(endpointFromEnv(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: ctx.conversationId }),
      signal: AbortSignal.timeout(145_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Boondi CRM extraction request failed (${res.status})${text ? `: ${text.slice(0, 160)}` : ''}`,
      );
    }
    const s = parseStats(await res.json());
    return `Lead/query extraction processed. Extracted: ${s.extracted}. Created: ${s.created}. Updated: ${s.updated}. Skipped: ${s.skipped}.`;
  },
};
