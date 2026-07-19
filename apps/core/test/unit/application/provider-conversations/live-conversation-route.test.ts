import { describe, expect, it } from 'vitest';

import { liveConversationRoute } from '@core/application/provider-conversations/live-conversation-route.js';

describe('liveConversationRoute', () => {
  it('derives the trigger from agent identity independently of the display name', () => {
    expect(
      liveConversationRoute({
        displayName: 'Team Channel',
        agentName: 'Main Agent',
        agentFolder: 'main_agent',
        agentId: 'agent:main_agent',
        providerAccountId: 'provider-account:main',
        conversationId: 'conversation:C1',
        addedAt: '2026-07-19T00:00:00.000Z',
        requiresTrigger: true,
        conversationKind: 'channel',
      }),
    ).toMatchObject({
      name: 'Team Channel',
      trigger: '@Main Agent',
    });
  });
});
