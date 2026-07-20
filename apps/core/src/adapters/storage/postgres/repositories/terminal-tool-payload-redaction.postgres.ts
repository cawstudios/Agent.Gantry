import { sql, type SQL } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';

export type TerminalToolPayloadRedactionInput = {
  runId: string;
  liveTurnId?: string | null;
};

/**
 * Replaces terminal caller-tool request/result bodies with deterministic hashes.
 * Call this from the same fenced transaction that commits the terminal run.
 */
export async function redactTerminalToolPayloads(
  executor: CanonicalExecutor,
  input: TerminalToolPayloadRedactionInput,
): Promise<void> {
  for (const statement of terminalToolPayloadRedactionStatements(input)) {
    await executor.execute(statement);
  }
}

export function terminalToolPayloadRedactionStatements(
  input: TerminalToolPayloadRedactionInput,
): SQL[] {
  const interactions = pgSchema.pendingInteractionsPostgres;
  const statements: SQL[] = [];
  if (input.liveTurnId) {
    const commands = pgSchema.liveTurnCommandsPostgres;
    const callerInteractions = pgSchema.pendingInteractionsPostgres;
    // Join while the interaction payload still contains its requestId.
    statements.push(sql`
      UPDATE ${commands}
      SET payload_json = jsonb_build_object(
        'redacted', true,
        'sha256', encode(digest(${commands.payloadJson}::text, 'sha256'), 'hex')
      )
      WHERE ${commands.liveTurnId} = ${input.liveTurnId}
        AND ${commands.commandType} = 'interaction_resolved'
        AND EXISTS (
          SELECT 1
          FROM ${callerInteractions}
          WHERE ${callerInteractions.runId} = ${input.runId}
            AND ${callerInteractions.payloadJson}->>'interactionType' = 'caller_resolved_tool'
            AND ${callerInteractions.payloadJson}->>'interactionId' = ${commands.payloadJson}->>'requestId'
        )
        AND COALESCE(${commands.payloadJson}->>'redacted', 'false') <> 'true'
    `);
  }
  statements.push(sql`
    UPDATE ${interactions}
    SET
      payload_json = jsonb_build_object(
        'redacted', true,
        'sha256', encode(digest(${interactions.payloadJson}::text, 'sha256'), 'hex')
      ),
      callback_route_json = CASE
        WHEN ${interactions.callbackRouteJson} IS NULL THEN NULL
        ELSE jsonb_build_object(
          'redacted', true,
          'sha256', encode(digest(${interactions.callbackRouteJson}::text, 'sha256'), 'hex')
        )
      END,
      resolution_json = CASE
        WHEN ${interactions.resolutionJson} IS NULL THEN NULL
        ELSE jsonb_build_object(
          'redacted', true,
          'sha256', encode(digest(${interactions.resolutionJson}::text, 'sha256'), 'hex')
        )
      END
    WHERE ${interactions.runId} = ${input.runId}
      AND ${interactions.payloadJson}->>'interactionType' = 'caller_resolved_tool'
      AND COALESCE(${interactions.payloadJson}->>'redacted', 'false') <> 'true'
  `);
  return statements;
}
