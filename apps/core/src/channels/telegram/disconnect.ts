import { logger } from '../../infrastructure/logging/logger.js';
import { TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS } from './channel-shared.js';

export async function disconnectTelegramDelivery(input: {
  bot: { stop(): void } | null;
  activeDraftStreams: Map<unknown, { closeStream(): void }>;
  activeGroupStreams: Map<unknown, unknown>;
  streamGenerationByJid: Map<unknown, unknown>;
  sealedStreamGenerationByJid: Map<unknown, unknown>;
  activeProgressMessages: Map<unknown, unknown>;
  mediaIngestionQueue: { waitForIdle(timeoutMs: number): Promise<boolean> };
  pendingPermissionPrompts: Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      callbackId: string;
      resolve(value: {
        approved: false;
        decidedBy: 'system';
        reason: string;
      }): void;
    }
  >;
  pendingPermissionCallbackIds: Map<string, unknown>;
  pendingUserQuestions: Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      multiSelect: boolean;
      resolve(value: {
        selected: string | string[];
        answeredBy: 'system';
      }): void;
    }
  >;
  releasePollingLease(): Promise<void>;
}): Promise<{ bot: null; draftStreamApi: null }> {
  for (const streamState of input.activeDraftStreams.values()) {
    streamState.closeStream();
  }
  input.activeDraftStreams.clear();
  input.activeGroupStreams.clear();
  input.streamGenerationByJid.clear();
  input.sealedStreamGenerationByJid.clear();
  input.activeProgressMessages.clear();
  const mediaDrained = await input.mediaIngestionQueue.waitForIdle(
    TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS,
  );
  if (!mediaDrained) {
    logger.warn(
      { timeoutMs: TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS },
      'Timed out waiting for Telegram media ingestion queue to drain',
    );
  }
  for (const [requestId, pending] of input.pendingPermissionPrompts.entries()) {
    clearTimeout(pending.timer);
    pending.resolve({
      approved: false,
      decidedBy: 'system',
      reason: 'Telegram channel disconnected',
    });
    input.pendingPermissionPrompts.delete(requestId);
    input.pendingPermissionCallbackIds.delete(pending.callbackId);
  }
  for (const [key, pending] of input.pendingUserQuestions.entries()) {
    clearTimeout(pending.timer);
    pending.resolve({
      selected: pending.multiSelect ? [] : '',
      answeredBy: 'system',
    });
    input.pendingUserQuestions.delete(key);
  }
  if (input.bot) {
    input.bot.stop();
    await input.releasePollingLease();
    logger.info('Telegram bot stopped');
  }
  return { bot: null, draftStreamApi: null };
}
