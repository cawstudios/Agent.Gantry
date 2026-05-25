import type {
  MemoryBoundaryDefaultScope,
  SessionMemoryCollector,
} from '../domain/ports/session-memory-collector.js';
import {
  MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
  runWithMemoryOperationTimeout,
} from '../shared/memory-dreaming-timeout.js';

type JobMemoryLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

export async function collectCompactBoundaryMemory(input: {
  compactBoundary?: boolean;
  agentSessionId?: string;
  collectMemory?: SessionMemoryCollector;
  defaultScope?: MemoryBoundaryDefaultScope;
  logger: JobMemoryLogger;
  context?: Record<string, unknown>;
}): Promise<void> {
  const agentSessionId = input.agentSessionId;
  const collectMemory = input.collectMemory;
  if (!input.compactBoundary || !agentSessionId || !collectMemory) {
    return;
  }
  try {
    const result = await runWithMemoryOperationTimeout(
      (signal) =>
        collectMemory({
          agentSessionId,
          trigger: 'precompact',
          ...(input.defaultScope ? { defaultScope: input.defaultScope } : {}),
          signal,
          timeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
          statementTimeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
        }),
      {
        timeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
        label: 'memory collection',
      },
    );
    input.logger.info(
      {
        ...input.context,
        agentSessionId,
        saved: result.saved,
      },
      'Collected durable memory at SDK compact boundary',
    );
  } catch (err) {
    input.logger.warn(
      { ...input.context, err },
      'Failed to collect durable memory at SDK compact boundary',
    );
  }
}

export async function collectJobCompletionMemory(input: {
  agentSessionId?: string;
  collectMemory?: SessionMemoryCollector;
  defaultScope?: MemoryBoundaryDefaultScope;
  prompt?: string | null;
  result?: string | null;
  logger: JobMemoryLogger;
  context?: Record<string, unknown>;
}): Promise<void> {
  const agentSessionId = input.agentSessionId;
  const collectMemory = input.collectMemory;
  const additionalTurns = [
    input.prompt ? { role: 'user' as const, text: input.prompt } : null,
    input.result ? { role: 'assistant' as const, text: input.result } : null,
  ].filter((turn): turn is { role: 'user' | 'assistant'; text: string } =>
    Boolean(turn?.text.trim()),
  );
  if (!agentSessionId || !collectMemory || additionalTurns.length === 0) {
    return;
  }
  try {
    const result = await runWithMemoryOperationTimeout(
      (signal) =>
        collectMemory({
          agentSessionId,
          trigger: 'session-end',
          ...(input.defaultScope ? { defaultScope: input.defaultScope } : {}),
          additionalTurns,
          signal,
          timeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
          statementTimeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
        }),
      {
        timeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
        label: 'memory collection',
      },
    );
    input.logger.info(
      {
        ...input.context,
        agentSessionId: input.agentSessionId,
        saved: result.saved,
      },
      'Collected durable memory after successful job run',
    );
  } catch (err) {
    input.logger.warn(
      { ...input.context, err },
      'Failed to collect durable memory after successful job run',
    );
  }
}
