import type { SessionEventEnvelope, SseEvent } from './types.js';

export function parseSessionSseEvent(input: {
  eventId: number;
  eventType: string;
  data: unknown;
}): SseEvent {
  const envelope =
    input.data && typeof input.data === 'object' && 'payload' in input.data
      ? (input.data as Partial<SessionEventEnvelope>)
      : undefined;
  return {
    eventId: input.eventId,
    eventType: input.eventType,
    sessionId:
      typeof envelope?.sessionId === 'string' || envelope?.sessionId === null
        ? envelope.sessionId
        : undefined,
    jobId:
      typeof envelope?.jobId === 'string' || envelope?.jobId === null
        ? envelope.jobId
        : undefined,
    runId:
      typeof envelope?.runId === 'string' || envelope?.runId === null
        ? envelope.runId
        : undefined,
    triggerId:
      typeof envelope?.triggerId === 'string' || envelope?.triggerId === null
        ? envelope.triggerId
        : undefined,
    conversationId:
      typeof envelope?.conversationId === 'string' ||
      envelope?.conversationId === null
        ? envelope.conversationId
        : undefined,
    threadId:
      typeof envelope?.threadId === 'string' || envelope?.threadId === null
        ? envelope.threadId
        : undefined,
    correlationId:
      typeof envelope?.correlationId === 'string' ||
      envelope?.correlationId === null
        ? envelope.correlationId
        : undefined,
    createdAt:
      typeof envelope?.createdAt === 'string' ? envelope.createdAt : undefined,
    payload: envelope?.payload ?? input.data,
  };
}
