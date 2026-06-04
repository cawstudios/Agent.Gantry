import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RecordsRepository } from '../db/records-repository.js';
import { getCallerPhone, jsonContent, toolErrorContent } from './shared.js';

export function registerGetOpenRecords(
  server: McpServer,
  repo: RecordsRepository,
): void {
  server.tool(
    'get_open_records',
    'Return the verified caller\'s OPEN query/lead (if any), so you can greet a returning customer personally and continue where they left off. Call with empty arguments {} on the first turn of a returning conversation. Returns {found:false} for a brand-new customer.',
    {},
    async () => {
      try {
        const phone = getCallerPhone();
        if (!phone) {
          return toolErrorContent(
            'IDENTITY_REQUIRED',
            'No verified caller identity on this request.',
          );
        }
        const rec = await repo.getOpenRecordByPhone(phone);
        if (!rec) return jsonContent({ found: false });
        return jsonContent({
          found: true,
          record: {
            status: rec.status,
            intentCategory: rec.intentCategory,
            occasion: rec.occasion,
            quantity: rec.quantity,
            quantityRaw: rec.quantityRaw,
            budgetPerGiftInr: rec.budgetPerGiftInr,
            budgetRaw: rec.budgetRaw,
            locations: rec.locations,
            timeline: rec.timeline,
            buyerType: rec.buyerType,
            customisation: rec.customisation,
            score: rec.score,
            band: rec.band,
            summaryBrief: rec.summaryBrief,
            updatedAt: rec.updatedAt,
          },
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
