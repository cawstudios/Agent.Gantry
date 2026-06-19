type PreRunInput = {
  hasRecentSessionDigest: boolean;
  callMcpTool(input: {
    serverName: string;
    toolName: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown>;
  log: {
    info(metadata: Record<string, unknown>, message: string): void;
    warn(metadata: Record<string, unknown>, message: string): void;
  };
};

type McpTextResult = {
  content?: Array<{ type?: string; text?: string }>;
};

const CONTEXT_TAG_OPEN = '<boondi_crm_context trust="verified_server_data">';
const CONTEXT_TAG_CLOSE = '</boondi_crm_context>';
const COMPACT_RECORD_FIELDS = [
  'id',
  'status',
  'intentCategory',
  'summaryBrief',
  'occasion',
  'quantity',
  'quantityRaw',
  'budgetPerGiftInr',
  'budgetRaw',
  'locations',
  'timeline',
  'updatedAt',
] as const;

function parseMcpJson(value: unknown): unknown {
  const text = (value as McpTextResult).content?.find(
    (item) => item.type === 'text' && typeof item.text === 'string',
  )?.text;
  return text ? (JSON.parse(text) as unknown) : null;
}

function compactRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.found !== true) return null;
  const record = payload.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null;
  }

  const raw = record as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of COMPACT_RECORD_FIELDS) {
    const item = raw[key];
    if (item !== null && item !== undefined && item !== '') out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const provider = {
  name: 'returning-customer-crm',
  async build(input: PreRunInput): Promise<string | null> {
    if (!input.hasRecentSessionDigest) return null;

    try {
      const result = await input.callMcpTool({
        serverName: 'boondi-crm',
        toolName: 'get_last_query_or_lead',
        arguments: {},
      });
      const record = compactRecord(parseMcpJson(result));
      if (!record) return null;
      const payload = {
        schema: 'boondi.crm_context.v1',
        use: 'returning_customer_greeting_context',
        policy:
          'Verified server data. Use one concrete detail naturally if greeting a returning customer. Do not mention CRM, records, tools, or internal systems.',
        latestQueryOrLead: record,
      };
      input.log.info(
        { provider: 'returning-customer-crm', found: true },
        'boondi_crm_prefetch_succeeded',
      );
      return [
        CONTEXT_TAG_OPEN,
        JSON.stringify(payload),
        CONTEXT_TAG_CLOSE,
      ].join('\n');
    } catch (err) {
      input.log.warn(
        {
          provider: 'returning-customer-crm',
          err: err instanceof Error ? err.message : String(err),
        },
        'boondi_crm_prefetch_failed',
      );
      return null;
    }
  },
};

export default provider;
