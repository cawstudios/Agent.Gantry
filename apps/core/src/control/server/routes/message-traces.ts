import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AppId } from '../../../domain/app/app.js';
import type { ConversationId } from '../../../domain/conversation/conversation.js';
import { RUNTIME_EVENT_TYPES } from '../../../domain/events/runtime-event-types.js';
import { nowIso } from '../../../shared/time/datetime.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { sendError, sendJson } from '../http.js';

const tracePayloadRoute = /^\/v1\/messages\/([^/]+)\/trace-payloads$/;

export async function handleMessageTraceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  _url: URL,
  pathname: string,
): Promise<boolean> {
  const match = tracePayloadRoute.exec(pathname);
  if (!match) return false;

  if (req.method !== 'GET') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return true;
  }

  const auth = authorizeControlRequest(req, res, ctx.keys, ['messages:admin']);
  if (!auth) return true;

  if (!ctx.getMessageTracePayloads || !ctx.publishRuntimeEvent) {
    sendError(
      res,
      503,
      'TRACE_PAYLOADS_UNAVAILABLE',
      'Trace payload reads require Gantry storage and runtime event audit wiring.',
    );
    return true;
  }

  const messageId = decodeURIComponent(match[1]!);
  const trace = await ctx.getMessageTracePayloads({
    appId: auth.appId as AppId,
    messageId,
  });
  await ctx.publishRuntimeEvent({
    appId: auth.appId as AppId,
    ...(trace?.conversationId
      ? { conversationId: trace.conversationId as ConversationId }
      : {}),
    eventType: RUNTIME_EVENT_TYPES.TRACE_PAYLOAD_READ,
    actor: `control:${auth.kid}`,
    responseMode: 'none',
    payload: {
      messageId,
      payloadsAvailable: Boolean(trace?.payloadsJson),
    },
    createdAt: nowIso(),
  });

  sendJson(res, 200, {
    payloads: trace?.payloadsJson ?? null,
  });
  return true;
}
