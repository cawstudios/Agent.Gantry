import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { AppMessageResponseRoute } from '../domain/types.js';
import {
  isRuntimeEventType,
  RUNTIME_EVENT_TYPES,
} from '../domain/events/runtime-event-types.js';
import type { AgentOutput } from './agent-spawn.js';

export { RUNTIME_EVENT_TYPES };

function runtimeEventDedupKey(input: {
  eventType: string;
  appId?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  jobId?: string;
  conversationId?: string;
  threadId?: string | null;
  correlationId?: string | null;
  responseMode?: AppMessageResponseRoute['responseMode'];
  webhookId?: string | null;
  payload?: unknown;
}): string {
  let payload: string;
  try {
    payload = JSON.stringify(input.payload) ?? 'undefined';
  } catch {
    payload = String(input.payload);
  }
  return [
    input.eventType,
    input.appId ?? '',
    input.agentId ?? '',
    input.sessionId ?? '',
    input.runId ?? '',
    input.jobId ?? '',
    input.conversationId ?? '',
    input.threadId ?? '',
    input.correlationId ?? '',
    input.responseMode ?? '',
    input.webhookId ?? '',
    payload,
  ].join('\u001f');
}

export async function forwardRuntimeEvents(input: {
  output: AgentOutput;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<void> | void;
  runtimeAppId: string;
  turnAgentId?: string;
  runId?: string;
  chatJid: string;
  sessionThreadId: string | null;
  turnResponseRoute?: AppMessageResponseRoute;
  forwardedKeys: Set<string>;
}): Promise<void> {
  const { output, publishRuntimeEvent } = input;
  if (!output.runtimeEvents?.length || !publishRuntimeEvent) return;
  for (const event of output.runtimeEvents) {
    if (!isRuntimeEventType(event.eventType)) continue;
    const appId = event.appId ?? input.runtimeAppId;
    if (!appId) continue;
    const sessionId = event.sessionId ?? input.turnResponseRoute?.sessionId;
    const threadId =
      event.threadId !== undefined
        ? event.threadId
        : input.turnResponseRoute
          ? input.turnResponseRoute.threadId
          : input.sessionThreadId;
    const correlationId =
      event.correlationId !== undefined
        ? event.correlationId
        : input.turnResponseRoute?.correlationId;
    const responseMode =
      event.responseMode ?? input.turnResponseRoute?.responseMode ?? 'none';
    const webhookId =
      event.webhookId !== undefined
        ? event.webhookId
        : input.turnResponseRoute?.webhookId;
    const eventKey = runtimeEventDedupKey({
      eventType: event.eventType,
      appId,
      agentId: event.agentId ?? input.turnAgentId,
      sessionId,
      runId: event.runId ?? input.runId,
      jobId: event.jobId,
      conversationId: event.conversationId ?? input.chatJid,
      threadId,
      correlationId,
      responseMode,
      webhookId,
      payload: event.payload,
    });
    if (input.forwardedKeys.has(eventKey)) continue;
    input.forwardedKeys.add(eventKey);
    await publishRuntimeEvent({
      appId: appId as never,
      ...((event.agentId ?? input.turnAgentId)
        ? { agentId: (event.agentId ?? input.turnAgentId) as never }
        : {}),
      ...(sessionId ? { sessionId: sessionId as never } : {}),
      ...((event.runId ?? input.runId)
        ? { runId: (event.runId ?? input.runId) as never }
        : {}),
      ...(event.jobId ? { jobId: event.jobId as never } : {}),
      conversationId: (event.conversationId ?? input.chatJid) as never,
      ...(threadId ? { threadId: threadId as never } : {}),
      eventType: event.eventType,
      actor: event.actor ?? 'runner',
      correlationId: correlationId ?? null,
      responseMode,
      webhookId: webhookId ?? null,
      payload: event.payload,
    });
  }
}
