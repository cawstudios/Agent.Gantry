import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { drainExternalMcpActivity } from '@core/runner/mcp/tools/caller-resolved-mcp-audit.js';

describe('caller-resolved MCP activity handoff', () => {
  it('drains redacted audit records incrementally', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gantry-caller-audit-'));
    const auditFile = join(directory, 'audit.jsonl');
    const first = { toolCallId: 'call-1', resultClass: 'success' };
    const second = { toolCallId: 'call-2', resultClass: 'failure' };
    writeFileSync(auditFile, `${JSON.stringify(first)}\n`, 'utf8');

    expect(drainExternalMcpActivity(auditFile)).toEqual([first]);
    expect(drainExternalMcpActivity(auditFile)).toEqual([]);
    appendFileSync(auditFile, `${JSON.stringify(second)}\n`, 'utf8');
    expect(drainExternalMcpActivity(auditFile)).toEqual([second]);

    rmSync(directory, { recursive: true, force: true });
  });
});
