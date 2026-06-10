// Self-contained agent-declared command. Like `guardrails/guardrail.ts`, it has
// NO import dependency on Gantry core: the context type is declared locally and
// the module is loaded by core's command-registry, which validates the exported
// shape `{ name, description, visibility, run }`. The heavy work and credentials
// live in the Boondi CRM service (mcp-crm); run() is a thin HMAC-signed HTTP call
// to its /admin/extract-leads-queries endpoint.
import { createHmac } from 'node:crypto';

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

function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function endpointFromEnv(): string {
  const configured = process.env.BOONDI_CRM_MCP_URL?.trim();
  if (configured) {
    const parsed = new URL(configured);
    parsed.pathname = '/admin/extract-leads-queries';
    parsed.search = '';
    return parsed.toString();
  }
  const port = process.env.BOONDI_CRM_MCP_PORT?.trim() || '8082';
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
  const secret = process.env.MCP_IDENTITY_SECRET?.trim();
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
  return {
    extracted: Number(stats?.extracted ?? 0),
    created: Number(stats?.created ?? 0),
    updated: Number(stats?.updated ?? 0),
    skipped: Number(stats?.skipped ?? 0),
  };
}

export const command = {
  name: 'extract-leads-queries',
  description: 'Extract CRM lead/query candidates from this conversation.',
  visibility: 'operator' as const,
  ackOnStart: 'Running lead/query extraction…',
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
