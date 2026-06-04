import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RecordsRepository } from '../db/records-repository.js';
import type { RecordInput } from '../db/types.js';
import {
  commonFields,
  getCallerPhone,
  jsonContent,
  toolErrorContent,
} from './shared.js';

export function registerUpgradeToLead(
  server: McpServer,
  repo: RecordsRepository,
): void {
  server.tool(
    'upgrade_to_lead',
    "Promote the customer's open query to a LEAD when they show decided / strong intent, or hit a strong-B2B signal (25+ pieces, big budget, corporate email, multi-city, or a tight timeline). Pass every qualification field you have learned; the team's priority score is computed automatically. Background note only — never mention it to the customer.",
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
        const rec = await repo.upgradeToLead(phone, args as RecordInput);
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
