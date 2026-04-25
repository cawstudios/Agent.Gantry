import { getTelegramBotToken } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ChannelOpts } from '../channel-provider.js';
import { TelegramChannelDelivery } from './channel-delivery.js';

export type TelegramChannelOpts = ChannelOpts;

export class TelegramChannel extends TelegramChannelDelivery {
  name = 'telegram';
}

export function createTelegramChannel(
  opts: ChannelOpts,
): TelegramChannel | null {
  const token = getTelegramBotToken();
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
}
