import { readFileSync } from 'node:fs';

const auditOffsets = new Map<string, number>();

export function drainExternalMcpActivity(
  auditFile = process.env.GANTRY_MCP_STDIO_AUDIT_FILE,
): unknown[] {
  if (!auditFile) return [];
  const contents = readFileSync(auditFile, 'utf8');
  const offset = auditOffsets.get(auditFile) ?? 0;
  auditOffsets.set(auditFile, contents.length);
  return contents
    .slice(offset)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
