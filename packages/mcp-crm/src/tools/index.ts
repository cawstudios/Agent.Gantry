import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RecordsRepository } from '../db/records-repository.js';
import { registerGetLastQueryOrLead } from './get-last-query-or-lead.js';
import { registerGetOpenRecords } from './get-open-records.js';

export const REGISTERED_TOOL_NAMES = [
  'get_last_query_or_lead',
  'get_open_records',
] as const;

export type RegisteredToolName = (typeof REGISTERED_TOOL_NAMES)[number];

// Boondi-owned CRM tool surface. Capture is now done by the background digest
// extractor (not the live agent), so only the READ tool remains here.
export function registerAllTools(
  server: McpServer,
  repo: RecordsRepository,
): void {
  registerGetLastQueryOrLead(server, repo);
  registerGetOpenRecords(server, repo);
}
