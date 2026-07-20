import { describe, expect, it, vi } from 'vitest';

import { createConversationOutboundProjection } from '../../../src/app/bootstrap/conversation-outbound-projection.js';

describe('conversation outbound projection', () => {
  it('publishes the provider external conversation id with a Teams receipt', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const projection = createConversationOutboundProjection({
      rawText: 'Tender notice',
      channelName: 'teams',
      providerId: 'teams',
      providerAccountId: 'teams-account-1',
      conversationJid: 'teams:teams-channel-1;messageid=root-message-1',
      appId: 'app-1' as never,
      messageId: 'gantry-message-1',
      publishRuntimeEvent,
      logger: { warn: vi.fn() },
    });

    await projection?.publishEvent({
      deliveryStatus: 'sent',
      externalMessageId: 'teams-message-1',
      terminal: true,
    });

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          messageId: 'gantry-message-1',
          providerId: 'teams',
          externalConversationId: 'teams-channel-1;messageid=root-message-1',
          externalMessageId: 'teams-message-1',
        }),
      }),
    );
  });
});
