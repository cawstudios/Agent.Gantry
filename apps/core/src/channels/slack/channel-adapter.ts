import { getSlackAppToken, getSlackBotToken } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ChannelOpts } from '../channel-provider.js';
import { SlackChannelDelivery } from './channel-delivery.js';

export class SlackChannel extends SlackChannelDelivery {
  name = 'slack';
}

export function createSlackChannel(opts: ChannelOpts): SlackChannel | null {
  const botToken = getSlackBotToken();
  const appToken = getSlackAppToken();
  if (!botToken || !appToken) {
    logger.warn('Slack: SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required');
    return null;
  }

  return new SlackChannel(botToken, appToken, opts);
}
