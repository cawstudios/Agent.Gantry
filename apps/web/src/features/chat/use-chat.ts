import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import {
  requireRuntimeTransport,
  useRuntimeConnection,
} from '../../lib/api/runtime-connection';
import type {
  ConversationDashboard,
  ConversationView,
} from '../operations/conversation-api';
import {
  chatQueryKeys,
  ensureChatSession,
  isTerminalSessionEvent,
  loadChatSession,
  sendChatMessage,
  streamChatEvents,
  visibleEventText,
} from './chat-api';

const KNOWN_SESSION_EVENTS = new Set([
  'session.message.inbound',
  'session.message.outbound',
  'session.message.streaming',
  'session.typing',
  'session.progress',
  'permission.requested',
  'permission.allowed',
  'permission.denied',
  'permission.cancelled',
  'interaction.pending',
  'run.started',
  'run.completed',
  'run.failed',
  'run.timeout',
  'run.canceled',
]);

export function useEnsureChatSession() {
  const connection = useRuntimeConnection();
  return useMutation({
    mutationFn: (conversation: ConversationView) =>
      ensureChatSession(
        requireRuntimeTransport(connection),
        connection.appId,
        conversation,
      ),
  });
}

export function useChatSession(
  sessionId: string,
  dashboard?: ConversationDashboard,
) {
  const connection = useRuntimeConnection();
  return useQuery({
    queryKey: chatQueryKeys.session(sessionId),
    enabled: Boolean(connection.transport && dashboard),
    queryFn: () =>
      loadChatSession(
        requireRuntimeTransport(connection),
        sessionId,
        dashboard as ConversationDashboard,
      ),
  });
}

export function useSendChatMessage(sessionId: string, threadId?: string) {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (message: string) =>
      sendChatMessage(requireRuntimeTransport(connection), {
        sessionId,
        message,
        threadId,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: chatQueryKeys.session(sessionId),
      });
    },
  });
}

export type SessionStreamState = {
  text: string;
  status: 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'error';
  error?: string;
};

export function useSessionEventStream(
  sessionId: string,
  startAfterEventId: number | null,
): SessionStreamState {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  const [state, setState] = useState<SessionStreamState>({
    text: '',
    status: 'idle',
  });

  useEffect(() => {
    if (startAfterEventId === null || !connection.transport) {
      setState({ text: '', status: 'idle' });
      return;
    }
    const controller = new AbortController();
    let active = true;
    let cursor = startAfterEventId;
    let pendingText = '';
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      if (!active) return;
      setState((current) => ({
        ...current,
        text: pendingText,
        status: 'streaming',
      }));
      flushTimer = undefined;
    };
    const scheduleFlush = () => {
      if (flushTimer === undefined) flushTimer = setTimeout(flush, 80);
    };
    const refetch = () =>
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.session(sessionId),
      });

    const run = async () => {
      for (let attempt = 0; attempt < 4 && active; attempt += 1) {
        setState((current) => ({
          ...current,
          status: attempt === 0 ? 'connecting' : 'reconnecting',
          error: undefined,
        }));
        try {
          for await (const event of streamChatEvents(
            connection.transport!,
            sessionId,
            cursor,
            controller.signal,
          )) {
            if (!active) return;
            cursor = event.eventId;
            const text = visibleEventText(event);
            if (text !== null) {
              pendingText =
                event.eventType === 'session.message.outbound'
                  ? text
                  : `${pendingText}${text}`;
              scheduleFlush();
            }
            if (!KNOWN_SESSION_EVENTS.has(event.eventType)) await refetch();
            if (event.eventType === 'session.message.outbound') await refetch();
            if (isTerminalSessionEvent(event)) {
              if (flushTimer !== undefined) clearTimeout(flushTimer);
              flush();
              await refetch();
              setState((current) => ({ ...current, status: 'idle' }));
              return;
            }
          }
          if (!active) return;
          await refetch();
        } catch (error) {
          if (!active || controller.signal.aborted) return;
          if (!(error instanceof Error)) throw error;
          await refetch();
          if (attempt === 3) {
            setState((current) => ({
              ...current,
              status: 'error',
              error: error.message,
            }));
            return;
          }
          await wait(500 * (attempt + 1), controller.signal);
        }
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
      if (flushTimer !== undefined) clearTimeout(flushTimer);
    };
  }, [connection.transport, queryClient, sessionId, startAfterEventId]);

  return state;
}

async function wait(milliseconds: number, signal: AbortSignal) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
