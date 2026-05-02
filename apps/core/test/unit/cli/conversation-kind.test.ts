import { describe, expect, it } from 'vitest';

import {
  slackConversationKindForChat,
  telegramConversationKindForChat,
} from '@core/cli/conversation-kind.js';

describe('CLI conversation kind mapping', () => {
  it('maps Telegram discovered and manual chats to settings kinds', () => {
    expect(
      telegramConversationKindForChat({
        chatJid: 'tg:5759865942',
        providerChatType: 'private',
      }),
    ).toBe('dm');
    expect(
      telegramConversationKindForChat({
        chatJid: 'tg:-1003986348737',
        providerChatType: 'supergroup',
      }),
    ).toBe('channel');
    expect(telegramConversationKindForChat({ chatJid: 'tg:-1001' })).toBe(
      'channel',
    );
  });

  it('maps Slack discovered and manual conversations to settings kinds', () => {
    expect(
      slackConversationKindForChat({
        chatJid: 'sl:D12345678',
        providerChatType: 'im',
      }),
    ).toBe('dm');
    expect(
      slackConversationKindForChat({
        chatJid: 'sl:G12345678',
        providerChatType: 'mpim',
      }),
    ).toBe('channel');
    expect(
      slackConversationKindForChat({
        chatJid: 'sl:C12345678',
        providerChatType: 'public_channel',
      }),
    ).toBe('channel');
    expect(slackConversationKindForChat({ chatJid: 'sl:D12345678' })).toBe(
      'dm',
    );
  });
});
