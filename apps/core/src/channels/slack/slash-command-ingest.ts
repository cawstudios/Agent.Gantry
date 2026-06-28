import { nowIso } from '../../shared/time/datetime.js';
import type { ChannelOpts } from '../channel-provider.js';

type SlackSlashCommandOpts = Pick<
  ChannelOpts,
  'onMessage' | 'onChatMetadata' | 'conversationRoutes'
>;

export async function ingestSlackSlashCommand(input: {
  command: {
    channel_id?: string;
    user_id?: string;
    user_name?: string;
    text?: string;
    trigger_id?: string;
    command_id?: string;
  };
  opts: SlackSlashCommandOpts;
  resolveChannelName(channelId: string): Promise<string | undefined>;
  resolveUserName(userId?: string): Promise<string>;
  isLikelyGroupConversation(channelId: string): boolean;
}): Promise<void> {
  const channelId = input.command.channel_id;
  if (!channelId) return;
  const jid = `sl:${channelId}`;
  const chatName = await input.resolveChannelName(channelId);
  await input.opts.onChatMetadata(
    jid,
    nowIso(),
    chatName,
    'slack',
    input.isLikelyGroupConversation(channelId),
  );
  const group = input.opts.conversationRoutes()[jid];
  if (!group && input.isLikelyGroupConversation(channelId)) return;
  const text = input.command.text?.trim();
  const content = text ? `/gantry ${text}` : '/gantry';
  const id =
    input.command.command_id ||
    input.command.trigger_id ||
    `gantry:${channelId}:${Date.now()}`;
  await input.opts.onMessage(jid, {
    id,
    chat_jid: jid,
    provider: 'slack',
    sender: input.command.user_id || 'unknown',
    sender_name:
      (input.command.user_id
        ? await input.resolveUserName(input.command.user_id)
        : input.command.user_name) ||
      input.command.user_name ||
      input.command.user_id ||
      'unknown',
    content,
    timestamp: nowIso(),
    is_from_me: false,
    external_message_id: id,
  });
}
