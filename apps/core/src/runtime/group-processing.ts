import {
  ASSISTANT_NAME,
  getDefaultModelConfig,
  getTriggerPattern,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  TIMEZONE,
} from '../config/index.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  MessageSendOptions,
  NewMessage,
  ProgressUpdateOptions,
  RegisteredGroup,
  StreamingChunkOptions,
} from '../domain/types.js';
import {
  formatMessages,
  formatOutboundForChannel,
} from '../messaging/router.js';
import {
  isSenderControlAllowed,
  isTriggerAllowed,
  loadSenderControlAllowlist,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';
import { AgentOutput, spawnAgent } from './agent-spawn.js';
import { archiveSessionTranscript } from '../session/session-transcript-archive.js';
import { handleSessionCommand } from '../session/session-commands.js';
import { createInjectedMemoryContextBlock } from './memory-context.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
import {
  getGroupMemoryStatus,
  saveGroupProcedureMemory,
} from './group-memory-commands.js';
import { runDreamingForGroup } from './memory-dreaming-runner.js';
import { sendWithPartialDeliveryGuard } from './partial-delivery.js';
import { firstThreadQueueId, parseThreadQueueKey } from './thread-queue-key.js';
import { formatElapsed } from './time-format.js';

const TYPING_HEARTBEAT_INTERVAL_MS = 4_000;
const ELAPSED_PROGRESS_INTERVAL_MS = 60_000;
const NO_OUTPUT_WARNING_INTERVAL_MS = 180_000;
const NO_VISIBLE_OUTPUT_FALLBACK_MESSAGE =
  'I finished that run but did not generate a user-visible reply. Please send your message again.';
let streamingGenerationCounter = 0;
function nextStreamingGeneration(): number {
  streamingGenerationCounter += 1;
  return streamingGenerationCounter;
}

export type { GroupProcessingDeps } from './group-processing-types.js';

export function createGroupProcessor(deps: GroupProcessingDeps): {
  processGroupMessages: (
    chatJid: string,
    options?: { queued?: boolean },
  ) => Promise<boolean>;
} {
  const runAgentImpl = deps.runAgent ?? spawnAgent;
  const ops = () => {
    const repository = deps.opsRepository ?? deps.getOpsRepository?.();
    if (!repository) {
      throw new Error('Group processor requires an OpsRepository');
    }
    return repository;
  };

  async function runAgent(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    queueJid: string,
    onOutput?: (output: AgentOutput) => Promise<void>,
    options?: {
      timeoutMs?: number;
      memoryContext?: {
        source: 'message' | 'command';
        userId?: string;
        threadId?: string;
      };
    },
  ): Promise<'success' | 'error'> {
    const isMain = group.isMain === true;
    const sessionThreadId = options?.memoryContext?.threadId ?? null;
    const sessionId = deps.getSession(group.folder, sessionThreadId);

    let pendingSessionId: string | null = null;

    const wrappedOnOutput = onOutput
      ? async (output: AgentOutput) => {
          if (output.status !== 'error' && output.newSessionId) {
            pendingSessionId = output.newSessionId;
          }
          await onOutput(output);
        }
      : undefined;

    const context = await createInjectedMemoryContextBlock({
      groupFolder: group.folder,
      chatJid,
      source: options?.memoryContext?.source || 'message',
      userId: options?.memoryContext?.userId,
      threadId: options?.memoryContext?.threadId,
    });
    try {
      const output = await runAgentImpl(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          threadId: options?.memoryContext?.threadId,
          isMain,
          assistantName: ASSISTANT_NAME,
          thinking: group.agentConfig?.thinking,
          memoryContextBlock: context?.block,
        },
        (proc, containerName) =>
          deps.queue.registerProcess(
            queueJid,
            proc,
            containerName,
            group.folder,
            queueJid === chatJid ? undefined : chatJid,
            options?.memoryContext?.threadId,
          ),
        wrappedOnOutput,
        options?.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined,
      );

      if (output.status === 'error') {
        const staleSessionId = sessionId || '';
        const isStaleSession =
          staleSessionId &&
          output.error &&
          /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
            output.error,
          );

        if (isStaleSession) {
          logger.warn(
            {
              group: group.name,
              staleSessionId,
              error: output.error,
            },
            'Stale session detected — clearing for next retry',
          );
          archiveSessionTranscript({
            groupFolder: group.folder,
            sessionId: staleSessionId,
            assistantName: ASSISTANT_NAME,
            cause: 'stale-session',
            errorSummary: output.error,
            writePlaceholderOnMissing: true,
          });
          await deps.clearSession(group.folder, sessionThreadId);
        }

        logger.error(
          { group: group.name, error: output.error },
          'Agent runner error',
        );
        return 'error';
      }

      const nextSessionId = output.newSessionId || pendingSessionId;
      if (nextSessionId) {
        await deps.setSession(group.folder, nextSessionId, sessionThreadId);
      }

      return 'success';
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  }

  async function processGroupMessages(
    queueJid: string,
    options: { queued?: boolean } = {},
  ): Promise<boolean> {
    const { chatJid, threadId: queueThreadId } = parseThreadQueueKey(queueJid);
    const group = deps.getGroup(chatJid);
    if (!group) return true;

    if (!deps.channelRuntime.hasChannel(chatJid)) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    const isMainGroup = group.isMain === true;

    const scopedQueue = options.queued === true || queueThreadId !== undefined;
    const messageFilter = scopedQueue
      ? { threadId: queueThreadId ?? null }
      : undefined;
    const missedMessages = await ops().getMessagesSince(
      chatJid,
      await deps.getCursor(queueJid),
      MAX_MESSAGES_PER_PROMPT,
      messageFilter,
    );

    if (missedMessages.length === 0) return true;

    const latestMessage = missedMessages[missedMessages.length - 1];
    const activeThreadId = firstThreadQueueId(
      queueThreadId,
      latestMessage.thread_id,
    );
    const resolveThreadId = async (
      threadId?: string,
    ): Promise<string | undefined> => {
      if (threadId) return threadId;
      return activeThreadId;
    };
    const streamGeneration = nextStreamingGeneration();
    const buildMessageOptions = async (
      threadId?: string,
    ): Promise<{ threadId: string } | undefined> => {
      const resolved = await resolveThreadId(threadId);
      return resolved ? { threadId: resolved } : undefined;
    };
    const buildStreamingOptions = async (args: {
      threadId?: string;
      done?: boolean;
    }): Promise<{ threadId?: string; done?: boolean; generation: number }> => {
      const resolvedThread = await resolveThreadId(args.threadId);
      const base = { generation: streamGeneration } as const;
      if (resolvedThread && args.done !== undefined) {
        return { ...base, threadId: resolvedThread, done: args.done };
      }
      if (resolvedThread) {
        return { ...base, threadId: resolvedThread };
      }
      if (args.done !== undefined) {
        return { ...base, done: args.done };
      }
      return { ...base };
    };
    const sendMessageToChannel = async (
      text: string,
      options?: MessageSendOptions,
    ): Promise<void> => {
      if (options) {
        await deps.channelRuntime.sendMessage(chatJid, text, options);
        return;
      }
      await deps.channelRuntime.sendMessage(chatJid, text);
    };
    const sendProgressToChannel = async (
      text: string,
      options?: ProgressUpdateOptions,
    ): Promise<void> => {
      if (options) {
        await deps.channelRuntime.sendProgressUpdate(chatJid, text, options);
        return;
      }
      await deps.channelRuntime.sendProgressUpdate(chatJid, text);
    };
    const resolveMemoryUserId = (): string | undefined => {
      for (let index = missedMessages.length - 1; index >= 0; index -= 1) {
        const message = missedMessages[index];
        if (!message) continue;
        const sender = message.sender?.trim();
        if (!sender) continue;
        if (message.is_from_me) continue;
        return sender;
      }
      const fallbackSender = latestMessage?.sender?.trim();
      return fallbackSender || undefined;
    };
    const memoryUserId = resolveMemoryUserId();

    const cmdResult = await handleSessionCommand({
      missedMessages,
      isMainGroup,
      groupName: group.name,
      triggerPattern: getTriggerPattern(group.trigger),
      timezone: TIMEZONE,
      deps: {
        sendMessage: (text, options) =>
          buildMessageOptions(options?.threadId).then((messageOptions) =>
            sendMessageToChannel(text, messageOptions),
          ),
        setTyping: (typing) => deps.channelRuntime.setTyping(chatJid, typing),
        runAgent: (prompt, onOutput, options) =>
          runAgent(group, prompt, chatJid, queueJid, onOutput, {
            ...options,
            memoryContext: {
              source: 'command',
              userId: memoryUserId,
              threadId: activeThreadId,
            },
          }),
        closeStdin: () => deps.queue.closeStdin(queueJid),
        advanceCursor: (message) => {
          deps.setCursor(
            queueJid,
            encodeGroupMessageCursor(toGroupMessageCursor(message)),
          );
          void Promise.resolve(deps.saveState()).catch((err: unknown) => {
            logger.warn(
              { group: group.name, err },
              'Failed to persist session command cursor',
            );
          });
        },
        formatMessages,
        getDefaultModel: () => getDefaultModelConfig().model,
        getGroupModelOverride: () => group.agentConfig?.model,
        setGroupModelOverride: async (value) =>
          deps.setGroupModelOverride(chatJid, value),
        getGroupThinkingOverride: () => group.agentConfig?.thinking,
        setGroupThinkingOverride: async (value) =>
          deps.setGroupThinkingOverride(chatJid, value),
        archiveCurrentSession: async (cause = 'new-session') => {
          const sessionId = deps.getSession(group.folder, activeThreadId);
          if (!sessionId) return;
          archiveSessionTranscript({
            groupFolder: group.folder,
            sessionId,
            assistantName: ASSISTANT_NAME,
            cause,
          });
        },
        clearCurrentSession: () =>
          deps.clearSession(group.folder, activeThreadId),
        stopCurrentRun: () => deps.queue.stopGroup?.(queueJid) ?? false,
        runMemoryDreaming: () => runDreamingForGroup(group.folder),
        getMemoryStatus: async () => getGroupMemoryStatus(group.folder),
        saveProcedure: async ({ title, body }) =>
          saveGroupProcedureMemory({
            groupFolder: group.folder,
            threadId: activeThreadId,
            isAdminWrite: isMainGroup,
            title,
            body,
          }),
        isSenderControlAllowlisted: (msg) => {
          const allowlistCfg = loadSenderControlAllowlist();
          return isSenderControlAllowed(
            chatJid,
            msg.sender,
            allowlistCfg,
            group.folder,
          );
        },
        canSenderInteract: (msg) => {
          const hasTrigger = getTriggerPattern(group.trigger).test(
            msg.content.trim(),
          );
          const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
          return (
            isMainGroup ||
            !reqTrigger ||
            (hasTrigger &&
              (msg.is_from_me ||
                isTriggerAllowed(
                  chatJid,
                  msg.sender,
                  loadSenderAllowlist(),
                  group.folder,
                )))
          );
        },
      },
    });
    if (cmdResult.handled) return cmdResult.success;

    if (!isMainGroup && group.requiresTrigger !== false) {
      const triggerPattern = getTriggerPattern(group.trigger);
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = missedMessages.some(
        (m) =>
          triggerPattern.test(m.content.trim()) &&
          (m.is_from_me ||
            isTriggerAllowed(chatJid, m.sender, allowlistCfg, group.folder)),
      );
      if (!hasTrigger) {
        return true;
      }
    }

    const prompt = formatMessages(missedMessages, TIMEZONE);
    const previousCursor = (await deps.getCursor(queueJid)) || '';
    deps.setCursor(
      queueJid,
      encodeGroupMessageCursor(
        toGroupMessageCursor(missedMessages[missedMessages.length - 1]),
      ),
    );
    await deps.saveState();

    logger.info(
      { group: group.name, messageCount: missedMessages.length },
      'Processing messages',
    );
    try {
      deps.channelRuntime.resetStreaming(chatJid);
    } catch (err) {
      logger.debug(
        { err, group: group.name },
        'Failed to reset channel streaming state before processing',
      );
    }

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing agent runner stdin',
        );
        deps.queue.closeStdin(queueJid);
      }, IDLE_TIMEOUT);
    };

    await deps.channelRuntime.setTyping(chatJid, true);
    const startedAt = Date.now();
    let lastAgentProgressAt = startedAt;
    let lastNoOutputWarningAt = 0;
    let lastElapsedProgressAt = 0;
    let typingHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    const supportsProgress = deps.channelRuntime.supportsProgress(chatJid);
    if (supportsProgress) {
      try {
        const progressOptions = await buildMessageOptions();
        await sendProgressToChannel('Working on it...', progressOptions);
      } catch (err) {
        logger.debug(
          { err, group: group.name },
          'Failed to send initial progress update',
        );
      }
    }
    typingHeartbeatTimer = setInterval(() => {
      void deps.channelRuntime
        .setTyping(chatJid, true)
        .catch((err) =>
          logger.debug(
            { err, group: group.name },
            'Failed to refresh typing heartbeat',
          ),
        );
    }, TYPING_HEARTBEAT_INTERVAL_MS);
    progressTimer = setInterval(() => {
      void (async () => {
        if (!supportsProgress) return;
        const now = Date.now();
        const elapsedMs = now - startedAt;
        if (now - lastElapsedProgressAt >= ELAPSED_PROGRESS_INTERVAL_MS) {
          lastElapsedProgressAt = now;
          const progressOptions = await buildMessageOptions();
          void sendProgressToChannel(
            `Still working (${formatElapsed(elapsedMs)})...`,
            progressOptions,
          ).catch((err) =>
            logger.debug(
              { err, group: group.name },
              'Failed to send elapsed progress update',
            ),
          );
        }
        if (
          now - lastAgentProgressAt >= NO_OUTPUT_WARNING_INTERVAL_MS &&
          now - lastNoOutputWarningAt >= NO_OUTPUT_WARNING_INTERVAL_MS
        ) {
          lastNoOutputWarningAt = now;
          const progressOptions = await buildMessageOptions();
          void sendProgressToChannel(
            `No new output yet, still running (${formatElapsed(elapsedMs)})...`,
            progressOptions,
          ).catch((err) =>
            logger.debug(
              { err, group: group.name },
              'Failed to send no-output warning',
            ),
          );
        }
      })();
    }, 5_000);
    let hadError = false;
    let outputSentToUser = false;
    let collectedOutput = '';
    let sawRawOutput = false;
    const supportsStreamingChunks =
      deps.channelRuntime.supportsStreaming(chatJid);
    let streamFinalized = false;
    const finalizeStreamingOutput = async (
      reason: 'success-marker' | 'error-marker' | 'turn-complete',
    ) => {
      if (!supportsStreamingChunks || streamFinalized) return;
      streamFinalized = true;
      try {
        await deps.channelRuntime.sendStreamingChunk(
          chatJid,
          '',
          await buildStreamingOptions({ done: true }),
        );
      } catch (err) {
        logger.warn(
          { err, group: group.name, reason },
          'Failed to finalize streaming output',
        );
      }
    };
    let output: 'success' | 'error' = 'error';
    try {
      output = await runAgent(
        group,
        prompt,
        chatJid,
        queueJid,
        async (result) => {
          lastAgentProgressAt = Date.now();
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            sawRawOutput = true;
            const text = formatOutboundForChannel(raw);
            logger.info(
              { group: group.name },
              `Agent output: ${raw.length} chars`,
            );
            if (text) {
              let delivered = false;
              if (supportsStreamingChunks) {
                delivered = await deps.channelRuntime.sendStreamingChunk(
                  chatJid,
                  raw,
                  await buildStreamingOptions({}),
                );
              } else {
                const messageOptions = await buildMessageOptions();
                delivered = await sendWithPartialDeliveryGuard(
                  () => sendMessageToChannel(text, messageOptions),
                  { group: group.name },
                );
              }
              if (delivered) outputSentToUser = true;
              collectedOutput += `${text}\n`;
            }
            resetIdleTimer();
          }

          if (result.status === 'success' && !result.result) {
            await finalizeStreamingOutput('success-marker');
            deps.queue.notifyIdle(queueJid);
            // End the runner loop after a completed query so typing/progress
            // finalize promptly instead of waiting for idle timeout.
            deps.queue.closeStdin(queueJid);
          }

          if (result.status === 'error') {
            hadError = true;
            await finalizeStreamingOutput('error-marker');
          }
        },
        {
          memoryContext: {
            source: 'message',
            userId: memoryUserId,
            threadId: activeThreadId,
          },
        },
      );
    } finally {
      await finalizeStreamingOutput('turn-complete');
      if (typingHeartbeatTimer) clearInterval(typingHeartbeatTimer);
      if (progressTimer) clearInterval(progressTimer);
      const elapsed = formatElapsed(Date.now() - startedAt);
      if (supportsProgress) {
        const finalStatus =
          output === 'error' || hadError
            ? `Failed after ${elapsed}.`
            : `Done in ${elapsed}.`;
        try {
          const finalProgressOptions = await buildStreamingOptions({
            done: true,
          });
          await sendProgressToChannel(finalStatus, finalProgressOptions);
        } catch (err) {
          logger.debug(
            { err, group: group.name },
            'Failed to send final progress update',
          );
        }
      }
      await deps.channelRuntime.setTyping(chatJid, false);
      if (idleTimer) clearTimeout(idleTimer);
    }

    if (output === 'error' || hadError) {
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      deps.setCursor(queueJid, previousCursor);
      await deps.saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    if (!outputSentToUser) {
      const fallbackText = collectedOutput.trim();
      if (fallbackText) {
        try {
          const messageOptions = await buildMessageOptions();
          await sendMessageToChannel(fallbackText, messageOptions);
          outputSentToUser = true;
          logger.warn(
            { group: group.name, fallbackChars: fallbackText.length },
            'Streamed output was not confirmed as delivered; sent fallback message',
          );
        } catch (err) {
          logger.warn(
            { err, group: group.name },
            'Failed to send fallback message after streaming run',
          );
        }
      } else if (sawRawOutput) {
        try {
          const messageOptions = await buildMessageOptions();
          await sendMessageToChannel(
            NO_VISIBLE_OUTPUT_FALLBACK_MESSAGE,
            messageOptions,
          );
          outputSentToUser = true;
          logger.warn(
            { group: group.name },
            'Agent produced only non-displayable output; sent explicit fallback notice',
          );
        } catch (err) {
          logger.warn(
            { err, group: group.name },
            'Failed to send no-visible-output fallback notice after streaming run',
          );
        }
      }
    }

    return true;
  }

  return { processGroupMessages };
}
