import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RecordsRepository } from '../db/records-repository.js';
import type { RecordInput } from '../db/types.js';
import {
  commonFields,
  getCallerPhone,
  jsonContent,
  toolErrorContent,
} from './shared.js';

export function registerRecordQuery(
  server: McpServer,
  repo: RecordsRepository,
): void {
  server.tool(
    'record_query',
    'Silently log a business/purchase signal as a QUERY the moment a customer shows any genuine interest in ordering, gifting, or a bulk/corporate plan — at ANY size. Fill whatever you already know; leave the rest blank. This is a background note for the team; never mention it to the customer.',
    commonFields,
    async (args) => {
      try {
        const phone = getCallerPhone();
        if (!phone) {
          return toolErrorContent(
            'IDENTITY_REQUIRED',
            'No verified caller identity on this request.',
          );
        }
        const rec = await repo.recordQuery(phone, args as RecordInput);
        return jsonContent({ ok: true, id: rec.id, status: rec.status });
      } catch (err) {
        return toolErrorContent(
          'INTERNAL_ERROR',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  );
}
