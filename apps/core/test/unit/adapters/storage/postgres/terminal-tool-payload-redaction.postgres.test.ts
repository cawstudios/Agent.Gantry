import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import {
  redactTerminalToolPayloads,
  terminalToolPayloadRedactionStatements,
} from '@core/adapters/storage/postgres/repositories/terminal-tool-payload-redaction.postgres.js';

describe('terminal caller-tool payload redaction', () => {
  it('targets caller-resolved interactions and live-turn resolution commands', () => {
    const dialect = new PgDialect();
    const queries = terminalToolPayloadRedactionStatements({
      runId: 'run-1',
      liveTurnId: 'turn-1',
    }).map((statement) => dialect.sqlToQuery(statement));

    expect(queries).toHaveLength(2);
    expect(queries[1]!.sql).toContain('UPDATE "pending_interactions"');
    expect(queries[1]!.sql).toMatch(/SET\s+payload_json =/);
    expect(queries[1]!.sql).toMatch(/,\s+callback_route_json =/);
    expect(queries[1]!.sql).toMatch(/,\s+resolution_json =/);
    expect(queries[1]!.sql).toContain(
      "'interactionType' = 'caller_resolved_tool'",
    );
    expect(queries[1]!.sql).toContain(
      'digest("pending_interactions"."payload_json"::text, \'sha256\')',
    );
    expect(queries[1]!.params).toEqual(['run-1']);
    expect(queries[0]!.sql).toContain('UPDATE "live_turn_commands"');
    expect(queries[0]!.sql).toMatch(/SET\s+payload_json =/);
    expect(queries[0]!.sql).toContain("= 'interaction_resolved'");
    expect(queries[0]!.sql).toContain('EXISTS');
    expect(queries[0]!.sql).toContain(
      `"pending_interactions"."payload_json"->>'interactionId' = "live_turn_commands"."payload_json"->>'requestId'`,
    );
    expect(queries[0]!.params).toEqual(['turn-1', 'run-1']);
  });

  it('executes only the run redaction when no live turn exists', async () => {
    const execute = vi.fn(async () => undefined);

    await redactTerminalToolPayloads({ execute } as never, { runId: 'run-1' });

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
