import {
  getTriggerPattern,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from '../config/index.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  NewMessage,
  ProgressUpdateOptions,
  ConversationRoute,
  MessageSendOptions,
} from '../domain/types.js';
import type { RuntimeMessageRepository } from '../domain/repositories/ops-repo.js';
import { formatMessages } from '../messaging/router.js';
import { handlePreAgentGuardrail } from './group-guardrail.js';
import type { GuardrailClassifier } from '../application/guardrails/types.js';
import {
  isSenderControlAllowed,
  isTriggerAllowed,
  loadSenderControlAllowlist,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';
import {
  extractSessionCommand,
  isSessionCommandAllowed,
} from '../session/session-commands.js';
import type { SessionCommand } from '../session/session-commands.js';
import { makeThreadQueueKey, parseThreadQueueKey } from './thread-queue-key.js';
import { resolveNonSelfSenderIds } from './session-resume-runtime.js';
import { isTestOperatorJid } from '../shared/test-mode.js';

export interface MessageLoopDeps {
  getConversationRoutes: () => Record<string, ConversationRoute>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  getOrRecoverCursor: (chatJid: string) => Promise<string> | string;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
  saveState: () => Promise<void> | void;
  hasChannel: (chatJid: string) => boolean;
  setTyping: (chatJid: string, isTyping: boolean) => Promise<void>;
  sendProgressUpdate: (
    chatJid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ) => Promise<void>;
  /**
   * Delivers a message to the customer-facing channel. Used by the
   * continuation-path guardrail to send a policy's canned reply without
   * spawning/continuing an agent. Optional so existing callers/tests that
   * never exercise the continuation guardrail keep working.
   */
  sendChannelMessage?: (
    chatJid: string,
    text: string,
    options?: MessageSendOptions,
  ) => Promise<void>;
  /**
   * Pre-agent guardrail classifier. When present, inbound messages routed to an
   * already-running agent (the continuation path) are screened the same way the
   * spawn path screens them in processGroupMessages, so the guardrail applies to
   * every message regardless of path.
   */
  guardrailClassifier?: GuardrailClassifier;
  queue: {
    sendMessage: (
      chatJid: string,
      text: string,
      options?: {
        threadId?: string | null;
        senderUserIds?: readonly string[] | null;
      },
    ) => boolean;
    enqueueMessageCheck: (chatJid: string) => void;
    closeStdin: (chatJid: string) => void;
    stopGroup?: (chatJid: string) => boolean;
  };
  handleActiveControlCommand?: (args: {
    chatJid: string;
    queueJid: string;
    group: ConversationRoute;
    message: NewMessage;
    command: SessionCommand;
  }) => Promise<boolean> | boolean;
  opsRepository?: RuntimeMessageRepository;
}

function resolveMessageRepository(
  deps: MessageLoopDeps,
): RuntimeMessageRepository {
  if (!deps.opsRepository) {
    throw new Error('Message loop requires a runtime message repository');
  }
  return deps.opsRepository;
}

function saveStateBestEffort(deps: MessageLoopDeps, chatJid: string): void {
  Promise.resolve(deps.saveState()).catch((err) =>
    logger.warn({ chatJid, err }, 'Failed to persist message cursor state'),
  );
}

export async function runMessagePollingTick(
  deps: MessageLoopDeps,
): Promise<void> {
  try {
    const opsRepository = resolveMessageRepository(deps);
    const conversationRoutes = deps.getConversationRoutes();
    const jids = Object.keys(conversationRoutes);
    const lastTimestamp = deps.getLastTimestamp();
    const { messages, newTimestamp } = await opsRepository.getNewMessages(
      jids,
      lastTimestamp,
    );

    if (newTimestamp !== lastTimestamp) {
      deps.setLastTimestamp(newTimestamp);
      if (messages.length > 0) {
        await deps.saveState();
      } else {
        saveStateBestEffort(deps, '*');
      }
    }

    if (messages.length > 0) {
      logger.info({ count: messages.length }, 'New messages');

      const messagesByGroup = new Map<string, NewMessage[]>();
      for (const msg of messages) {
        const queueJid = makeThreadQueueKey(msg.chat_jid, msg.thread_id);
        const existing = messagesByGroup.get(queueJid);
        if (existing) {
          existing.push(msg);
        } else {
          messagesByGroup.set(queueJid, [msg]);
        }
      }

      for (const [queueJid, groupMessages] of messagesByGroup) {
        const { chatJid, threadId } = parseThreadQueueKey(queueJid);
        const group = conversationRoutes[chatJid];
        if (!group) continue;

        if (!deps.hasChannel(chatJid)) {
          logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
          continue;
        }

        const triggerPattern = getTriggerPattern(group.trigger);
        const loopCmdMsg = groupMessages.find(
          (m) => extractSessionCommand(m.content, triggerPattern) !== null,
        );

        if (loopCmdMsg) {
          const loopCommand = extractSessionCommand(
            loopCmdMsg.content,
            triggerPattern,
          );
          const controlAllowlistCfg = loadSenderControlAllowlist();
          if (
            isSessionCommandAllowed(
              loopCmdMsg.is_from_me === true,
              isSenderControlAllowed(
                chatJid,
                loopCmdMsg.sender,
                controlAllowlistCfg,
                group.folder,
              ) ||
                // DEV/TESTING ONLY: the configured test operator may run session
                // commands (e.g. /new) on their own conversation even while the
                // agent run is warm, so the scenario harness can fully reset
                // between runs. No-op in production (operator phone unset).
                isTestOperatorJid(chatJid),
            )
          ) {
            if (loopCommand && deps.handleActiveControlCommand) {
              const handled = await deps.handleActiveControlCommand({
                chatJid,
                queueJid,
                group,
                message: loopCmdMsg,
                command: loopCommand,
              });
              if (handled) {
                continue;
              }
            }
            if (loopCommand?.kind === 'stop') {
              deps.queue.stopGroup?.(queueJid);
            } else {
              deps.queue.closeStdin(queueJid);
            }
          }
          deps.queue.enqueueMessageCheck(queueJid);
          continue;
        }

        const needsTrigger = group.requiresTrigger !== false;
        if (needsTrigger) {
          const allowlistCfg = loadSenderAllowlist();
          const hasTrigger = groupMessages.some(
            (m) =>
              triggerPattern.test(m.content.trim()) &&
              (m.is_from_me ||
                isTriggerAllowed(
                  chatJid,
                  m.sender,
                  allowlistCfg,
                  group.folder,
                )),
          );
          if (!hasTrigger) continue;
        }

        let initialBatch = await opsRepository.getMessagesSince(
          chatJid,
          await deps.getOrRecoverCursor(queueJid),
          MAX_MESSAGES_PER_PROMPT,
          { threadId: threadId ?? null },
        );
        if (initialBatch.length === 0) {
          initialBatch = groupMessages;
        }

        let pipedAny = false;
        let shouldEnqueueMessageCheck = false;
        let nextBatch: NewMessage[] | null = initialBatch;

        while (nextBatch && nextBatch.length > 0) {
          const messagesToSend = nextBatch;

          // Guardrail parity: screen this batch before piping it into the
          // already-running agent. The spawn path guards in
          // processGroupMessages, but the continuation path writes straight to
          // the live agent and never goes through it — so without this check a
          // policy-violating message that lands while the agent is still warm
          // would bypass the guardrail entirely. We reuse the same
          // handlePreAgentGuardrail so the decision (and canned reply) is
          // identical on both paths. Gated on sendChannelMessage being wired;
          // handlePreAgentGuardrail itself no-ops when the group has no
          // guardrail configured, so unconfigured groups are unaffected.
          if (deps.sendChannelMessage) {
            const sendChannelMessage = deps.sendChannelMessage;
            const latestMessage = messagesToSend[messagesToSend.length - 1];
            const guardrailBlocked = await handlePreAgentGuardrail({
              group,
              messages: messagesToSend,
              latestMessage,
              queueJid,
              guardrailClassifier: deps.guardrailClassifier,
              sendMessage: (text: string, options?: MessageSendOptions) =>
                sendChannelMessage(chatJid, text, options),
              buildMessageOptions: (tid?: string) =>
                tid ? { threadId: tid } : undefined,
              setCursor: deps.setAgentCursor,
              saveState: deps.saveState,
              info: (metadata, message) => logger.info(metadata, message),
            });
            if (guardrailBlocked) {
              // Canned reply sent and cursor advanced past this batch inside the
              // guardrail. Do not pipe it to the agent. Any later messages stay
              // after the cursor and are picked up by the enqueue below.
              shouldEnqueueMessageCheck = true;
              break;
            }
          }

          const formatted = formatMessages(messagesToSend, TIMEZONE);
          const senderUserIds = resolveNonSelfSenderIds(messagesToSend);
          const a = !deps.queue.sendMessage(queueJid, formatted, {
            threadId,
            senderUserIds,
          });
          if (a) {
            shouldEnqueueMessageCheck = true;
            break;
          }

          pipedAny = true;
          logger.debug(
            { chatJid, count: messagesToSend.length },
            'Piped messages to active agent run',
          );
          deps.setAgentCursor(
            queueJid,
            encodeGroupMessageCursor(
              toGroupMessageCursor(messagesToSend[messagesToSend.length - 1]),
            ),
          );
          saveStateBestEffort(deps, chatJid);

          if (messagesToSend.length < MAX_MESSAGES_PER_PROMPT) {
            break;
          }

          nextBatch = await opsRepository.getMessagesSince(
            chatJid,
            await deps.getOrRecoverCursor(queueJid),
            MAX_MESSAGES_PER_PROMPT,
            { threadId: threadId ?? null },
          );
        }

        if (pipedAny) {
          deps
            .setTyping(chatJid, true)
            .catch((err: unknown) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
        }

        if (!pipedAny || shouldEnqueueMessageCheck) {
          deps.queue.enqueueMessageCheck(queueJid);
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error in message loop');
  }
}

export async function startMessagePollingLoop(
  deps: MessageLoopDeps,
): Promise<never> {
  while (true) {
    await runMessagePollingTick(deps);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

export async function recoverPendingMessages(
  deps: MessageLoopDeps,
): Promise<void> {
  const opsRepository = resolveMessageRepository(deps);
  for (const [chatJid, group] of Object.entries(deps.getConversationRoutes())) {
    const queuedThreads = new Set<string>();
    let pendingCount = 0;

    for (const threadId of await opsRepository.getMessageThreadIds(chatJid)) {
      const queueJid = makeThreadQueueKey(chatJid, threadId);
      const pending = await opsRepository.getMessagesSince(
        chatJid,
        await deps.getOrRecoverCursor(queueJid),
        MAX_MESSAGES_PER_PROMPT,
        { threadId },
      );
      if (pending.length > 0) {
        pendingCount += pending.length;
        queuedThreads.add(queueJid);
      }
    }

    if (pendingCount === 0) continue;

    logger.info(
      { group: group.name, pendingCount },
      'Recovery: found unprocessed messages',
    );
    for (const queueJid of queuedThreads) {
      deps.queue.enqueueMessageCheck(queueJid);
    }
  }
}
