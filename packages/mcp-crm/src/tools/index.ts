import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RecordsRepository } from '../db/records-repository.js';
import { registerRecordQuery } from './record-query.js';
import { registerUpgradeToLead } from './upgrade-to-lead.js';
import { registerUpdateRecord } from './update-record.js';
import { registerGetOpenRecords } from './get-open-records.js';

export const REGISTERED_TOOL_NAMES = [
  'record_query',
  'upgrade_to_lead',
  'update_record',
  'get_open_records',
] as const;

export type RegisteredToolName = (typeof REGISTERED_TOOL_NAMES)[number];

// Boondi-owned CRM tools. Unlike mcp-shopify these are intentionally WRITE
// tools (record/upgrade/update), so there is no read-only-name guard here.
export function registerAllTools(
  server: McpServer,
  repo: RecordsRepository,
): void {
  registerRecordQuery(server, repo);
  registerUpgradeToLead(server, repo);
  registerUpdateRecord(server, repo);
  registerGetOpenRecords(server, repo);
}
