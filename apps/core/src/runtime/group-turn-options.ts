import { randomUUID } from 'crypto';

import type {
  MessageSendOptions,
  ProgressUpdateOptions,
  StreamingChunkOptions,
} from '../domain/types.js';

export function createGroupTurnOptionBuilders(input: {
  activeThreadId?: string;
  providerAccountId?: string;
  runId: () => string | undefined;
  appResponseRoute?: import('../domain/types.js').AppMessageResponseRoute;
  streamGeneration: () => number;
  progressGeneration: () => number;
}): {
  buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
  buildStreamingOptions: (args: {
    threadId?: string;
    done?: boolean;
  }) => StreamingChunkOptions;
  liveStopActionToken: string;
  buildProgressOptions: (args?: {
    threadId?: string;
    done?: boolean;
    replaceOnly?: boolean;
  }) => ProgressUpdateOptions;
} {
  const resolveThreadId = (threadId?: string) =>
    threadId ?? input.activeThreadId;
  const liveStopActionToken = randomUUID();
  return {
    buildMessageOptions: (threadId?: string) => {
      const resolved = resolveThreadId(threadId);
      const runId = input.runId();
      if (
        !resolved &&
        !input.providerAccountId &&
        !runId &&
        !input.appResponseRoute
      ) {
        return undefined;
      }
      return {
        ...(resolved ? { threadId: resolved } : {}),
        ...(input.providerAccountId
          ? { providerAccountId: input.providerAccountId }
          : {}),
        ...(runId ? { runId } : {}),
        ...(input.appResponseRoute
          ? { appResponseRoute: input.appResponseRoute }
          : {}),
      };
    },
    buildStreamingOptions: (args: { threadId?: string; done?: boolean }) => {
      const runId = input.runId();
      return {
        generation: input.streamGeneration(),
        ...(resolveThreadId(args.threadId)
          ? { threadId: resolveThreadId(args.threadId) }
          : {}),
        ...(input.providerAccountId
          ? { providerAccountId: input.providerAccountId }
          : {}),
        ...(runId ? { runId } : {}),
        ...(input.appResponseRoute
          ? { appResponseRoute: input.appResponseRoute }
          : {}),
        ...(args.done !== undefined ? { done: args.done } : {}),
      };
    },
    liveStopActionToken,
    buildProgressOptions: (
      args: { threadId?: string; done?: boolean; replaceOnly?: boolean } = {},
    ) => ({
      ...(resolveThreadId(args.threadId)
        ? { threadId: resolveThreadId(args.threadId) }
        : {}),
      ...(input.providerAccountId
        ? { providerAccountId: input.providerAccountId }
        : {}),
      generation: input.progressGeneration(),
      ...(args.done !== undefined ? { done: args.done } : {}),
      ...(args.replaceOnly !== undefined
        ? { replaceOnly: args.replaceOnly }
        : {}),
      ...(args.done
        ? {}
        : {
            actionAffordances: [
              {
                kind: 'live_turn_stop' as const,
                label: 'Stop',
                actionToken: liveStopActionToken,
              },
            ],
          }),
    }),
  };
}
