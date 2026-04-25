import type { ChannelAdapter } from '../../channels/channel-provider.js';
import type { NewMessage } from '../../domain/types.js';
import type { OpsRepository } from '../../domain/repositories/ops-repo.js';
import type { RuntimeApp } from './runtime-app.js';
import type { AsyncTaskQueue } from './async-task-queue.js';
import type { ChannelWiringDeps } from './channel-wiring-types.js';

interface ChannelPersistenceHandlerDeps {
  app: RuntimeApp;
  resolved: ChannelWiringDeps;
  ops: () => OpsRepository;
  findBoundChannel: (jid: string) => ChannelAdapter | undefined;
  persistenceQueue: AsyncTaskQueue;
}

export function createChannelPersistenceHandlers({
  app,
  resolved,
  ops,
  findBoundChannel,
  persistenceQueue,
}: ChannelPersistenceHandlerDeps) {
  return {
    onMessage: async (chatJid: string, msg: NewMessage) => {
      const trimmed = msg.content.trim();
      const registeredGroups = app.getRegisteredGroups();
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = resolved.loadSenderAllowlist();
        if (
          resolved.shouldDropMessage(
            chatJid,
            cfg,
            registeredGroups[chatJid]?.folder,
          ) &&
          !resolved.isSenderAllowed(
            chatJid,
            msg.sender,
            cfg,
            registeredGroups[chatJid]?.folder,
          )
        ) {
          if (resolved.shouldLogDenied(chatJid, cfg)) {
            resolved.logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }

      const remoteControlCommand = resolved.asRemoteControlCommand(trimmed);
      if (remoteControlCommand) {
        const allowlistCfg = resolved.loadSenderControlAllowlist();
        try {
          await resolved.handleRemoteControlCommand(
            remoteControlCommand,
            chatJid,
            msg,
            (jid) => app.getRegisteredGroups()[jid],
            findBoundChannel,
            (candidateMsg) =>
              resolved.isSenderControlAllowed(
                chatJid,
                candidateMsg.sender,
                allowlistCfg,
                registeredGroups[chatJid]?.folder,
              ),
          );
        } catch (err) {
          resolved.logger.error(
            { err, chatJid },
            'Remote control command error',
          );
        }
        return;
      }

      const persistMessage = async () => {
        try {
          await ops().storeMessage(msg);
        } catch (err) {
          resolved.logger.error({ err, chatJid }, 'Failed to store message');
        }
      };
      const admitted = persistenceQueue.enqueue(persistMessage);
      if (!admitted) {
        resolved.logger.warn(
          { chatJid, queueSize: persistenceQueue.size() },
          'Persistence queue full; waiting to enqueue message persistence',
        );
        await persistenceQueue.enqueueWhenAvailable(persistMessage);
      }
    },
    onChatMetadata: async (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => {
      const persistMetadata = async () => {
        try {
          await ops().storeChatMetadata(
            chatJid,
            timestamp,
            name,
            channel,
            isGroup,
          );
        } catch (err) {
          resolved.logger.error(
            { err, chatJid },
            'Failed to store chat metadata',
          );
        }
      };
      const admitted = persistenceQueue.enqueue(persistMetadata);
      if (!admitted) {
        resolved.logger.warn(
          { chatJid, queueSize: persistenceQueue.size() },
          'Persistence queue full; waiting to enqueue chat metadata persistence',
        );
        await persistenceQueue.enqueueWhenAvailable(persistMetadata);
      }
    },
  };
}
