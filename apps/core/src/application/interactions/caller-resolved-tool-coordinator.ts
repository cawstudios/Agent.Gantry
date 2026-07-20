import {
  recordPendingInteractionRequested,
  resolvePendingInteractionRecord,
} from './pending-interaction-durability.js';

const COMPLETED_TTL_MS = 5 * 60_000;

type Resolution =
  | { status: 'resolved'; result: unknown }
  | { status: 'rejected' | 'cancelled'; error: string };

interface PendingCallerTool {
  readonly appId: string;
  readonly runId?: string;
  readonly sourceAgentFolder: string;
  readonly sessionId: string;
  readonly interactionId: string;
  readonly resolve: (resolution: Resolution) => void;
  readonly timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingCallerTool>();
const completed = new Map<
  string,
  { idempotencyKey: string; expiresAt: number }
>();

function key(sessionId: string, interactionId: string): string {
  return `${sessionId}:${interactionId}`;
}

function pruneCompleted(): void {
  const now = Date.now();
  for (const [entryKey, entry] of completed) {
    if (entry.expiresAt <= now) completed.delete(entryKey);
  }
}

/** Records and waits for a domain-neutral tool result supplied through the SDK. */
export async function requestCallerResolvedTool(input: {
  appId: string;
  runId?: string;
  sourceAgentFolder: string;
  sessionId: string;
  interactionId: string;
  toolName: string;
  toolInput: unknown;
  timeoutMs: number;
  signal: AbortSignal;
  emitRequired: () => Promise<void>;
}): Promise<unknown> {
  const entryKey = key(input.sessionId, input.interactionId);
  const result = new Promise<Resolution>((resolve) => {
    const timer = setTimeout(
      () =>
        resolve({
          status: 'rejected',
          error: 'Caller tool interaction expired.',
        }),
      input.timeoutMs,
    );
    pending.set(entryKey, {
      appId: input.appId,
      runId: input.runId,
      sourceAgentFolder: input.sourceAgentFolder,
      sessionId: input.sessionId,
      interactionId: input.interactionId,
      resolve,
      timer,
    });
  });
  const abort = () => {
    pending.get(entryKey)?.resolve({
      status: 'cancelled',
      error: 'Caller tool interaction cancelled.',
    });
  };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    await recordPendingInteractionRequested({
      kind: 'question',
      sourceAgentFolder: input.sourceAgentFolder,
      requestId: input.interactionId,
      appId: input.appId,
      runId: input.runId,
      ttlMs: input.timeoutMs,
      payload: {
        interactionType: 'caller_resolved_tool',
        sessionId: input.sessionId,
        interactionId: input.interactionId,
        toolName: input.toolName,
        toolInput: input.toolInput,
      },
    });
    await input.emitRequired();
    const resolution = await result;
    if (resolution.status !== 'resolved') throw new Error(resolution.error);
    return resolution.result;
  } finally {
    input.signal.removeEventListener('abort', abort);
    const active = pending.get(entryKey);
    if (active) clearTimeout(active.timer);
    pending.delete(entryKey);
  }
}

/** Resolves or rejects a waiting caller tool exactly once per idempotency key. */
export async function settleCallerResolvedTool(input: {
  appId: string;
  sessionId: string;
  interactionId: string;
  idempotencyKey: string;
  resolution: Resolution;
  approverRef?: string | null;
}): Promise<'resolved' | 'idempotent' | 'not_found' | 'conflict'> {
  pruneCompleted();
  const entryKey = key(input.sessionId, input.interactionId);
  const previous = completed.get(entryKey);
  if (previous)
    return previous.idempotencyKey === input.idempotencyKey
      ? 'idempotent'
      : 'conflict';
  const active = pending.get(entryKey);
  if (!active || active.appId !== input.appId) return 'not_found';
  const persisted = await resolvePendingInteractionRecord({
    kind: 'question',
    sourceAgentFolder: active.sourceAgentFolder,
    requestId: active.interactionId,
    appId: active.appId,
    runId: active.runId,
    status: input.resolution.status === 'resolved' ? 'resolved' : 'cancelled',
    resolution: input.resolution,
    approverRef: input.approverRef,
  });
  if (!persisted) return 'conflict';
  completed.set(entryKey, {
    idempotencyKey: input.idempotencyKey,
    expiresAt: Date.now() + COMPLETED_TTL_MS,
  });
  clearTimeout(active.timer);
  active.resolve(input.resolution);
  return 'resolved';
}

/** Cancels every currently waiting interaction for a session. */
export function cancelCallerResolvedTools(sessionId: string): number {
  let count = 0;
  for (const active of pending.values()) {
    if (active.sessionId !== sessionId) continue;
    active.resolve({ status: 'cancelled', error: 'Session turn cancelled.' });
    count += 1;
  }
  return count;
}
