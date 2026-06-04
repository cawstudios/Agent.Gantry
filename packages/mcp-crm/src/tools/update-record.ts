import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RecordsRepository } from '../db/records-repository.js';
import type { RecordInput } from '../db/types.js';
import {
  commonFields,
  getCallerPhone,
  jsonContent,
  toolErrorContent,
} from './shared.js';

export function registerUpdateRecord(
  server: McpServer,
  repo: RecordsRepository,
): void {
  server.tool(
    'update_record',
    "Add or correct fields on the customer's open query/lead as you learn more over the conversation (e.g. they share the budget a few turns later). If it is already a lead, the score is recomputed. Background note only — never mention it to the customer.",
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
        const rec = await repo.updateRecord(phone, args as RecordInput);
        return jsonContent({
          ok: true,
          id: rec.id,
          status: rec.status,
          score: rec.score,
          band: rec.band,
        });
      } catch (err) {
        return toolErrorContent(
          'INTERNAL_ERROR',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  );
}
