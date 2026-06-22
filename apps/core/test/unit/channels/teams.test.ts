import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getProvider,
  providerForJid,
} from '@core/channels/provider-registry.js';
import '@core/channels/register-builtins.js';
import {
  TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
  TeamsChannel,
  type TeamsSdkClient,
  buildTeamsApprovalDescriptorPayload,
  createTeamsChannel,
  normalizeTeamsJid,
  teamsConversationIdFromJid,
} from '@core/channels/teams.js';
import {
  _testExternalCardActions,
  buildExternalCardActionGraphqlRequest,
} from '@core/channels/teams-external-card-actions.js';
import { signExternalCardActionForVerification } from '@core/control/server/routes/external-notification-card.js';
import { _testTeamsBotFrameworkClient } from '@core/channels/teams-bot-framework-client.js';
import type { ChannelOpts } from '@core/channels/channel-provider.js';
import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

afterEach(() => {
  configurePendingInteractionDurability(null);
});

function makeOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(async () => {}),
    onChatMetadata: vi.fn(async () => {}),
    conversationRoutes: vi.fn(() => ({})),
    runtimeSecrets: {
      getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error(`Missing ${ref.env}`);
        return value;
      },
      getOptionalSecret(ref) {
        return {
          TEAMS_CLIENT_ID: 'client-id',
          TEAMS_CLIENT_SECRET: 'client-secret',
          TEAMS_TENANT_ID: 'tenant-id',
        }[ref.env];
      },
    },
  };
}

describe('Teams built-in provider', () => {
  it('registers Teams provider metadata and ownership prefix', () => {
    const provider = getProvider('teams');

    expect(provider).toEqual(
      expect.objectContaining({
        id: 'teams',
        label: 'Teams',
        jidPrefix: 'teams:',
        folderPrefix: 'teams_',
        formatting: 'markdown-native',
      }),
    );
    expect(provider?.setup.envKeys).toEqual([
      'TEAMS_CLIENT_ID',
      'TEAMS_CLIENT_SECRET',
      'TEAMS_TENANT_ID',
      'TEAMS_BOT_APP_ID',
      'TEAMS_BOT_APP_PASSWORD',
    ]);
    expect(providerForJid('teams:19:abc@thread.v2')?.id).toBe('teams');
  });
});

describe('Teams Bot Framework adapter helpers', () => {
  it('formats adaptive card invoke responses with the Teams response body schema', () => {
    expect(
      _testTeamsBotFrameworkClient.createAdaptiveCardInvokeResponse(
        200,
        'application/vnd.microsoft.activity.message',
        'Action received.',
      ),
    ).toEqual({
      status: 200,
      body: {
        statusCode: 200,
        type: 'application/vnd.microsoft.activity.message',
        value: 'Action received.',
      },
    });
  });

  it('prefers Teams AAD object ids for sender authorization', () => {
    expect(
      _testTeamsBotFrameworkClient.getTeamsSender({
        type: 'message',
        from: {
          id: 'teams-user-id',
          name: 'Priya',
          aadObjectId: 'aad-user-id',
        } as never,
      }),
    ).toEqual({ id: 'aad-user-id', name: 'Priya', idKind: 'aad_object_id' });
  });

  it('reads tenant ids from Teams channel data', () => {
    expect(
      _testTeamsBotFrameworkClient.getTeamsTenantId({
        type: 'message',
        channelData: {
          tenant: {
            id: 'tenant-1',
          },
        },
      }),
    ).toBe('tenant-1');
  });

  it('builds redacted Teams activity diagnostics for invoke ingress', () => {
    expect(
      _testTeamsBotFrameworkClient.buildTeamsActivityDiagnostic({
        type: 'invoke',
        name: 'adaptiveCard/action',
        conversation: {
          id: '19:abc@thread.v2',
          conversationType: 'channel',
        },
        from: {
          id: 'teams-user-id',
          aadObjectId: 'aad-user-id',
        } as never,
        channelData: {
          tenant: {
            id: 'tenant-1',
          },
        },
        value: {
          action: {
            data: {
              nonce: 'secret-nonce',
            },
          },
          trigger: 'manual',
        },
      }),
    ).toEqual({
      activityType: 'invoke',
      activityName: 'adaptiveCard/action',
      conversationId: '19:abc@thread.v2',
      conversationType: 'channel',
      tenantId: 'tenant-1',
      senderIdKind: 'aad_object_id',
      hasValue: true,
      valueKeys: ['action', 'trigger'],
    });
  });
});

describe('Teams JID helpers', () => {
  it('normalizes Teams conversation ids into canonical Teams JIDs', () => {
    expect(normalizeTeamsJid('19:abc@thread.v2')).toBe(
      'teams:19:abc@thread.v2',
    );
    expect(normalizeTeamsJid(' teams:19:abc@thread.v2 ')).toBe(
      'teams:19:abc@thread.v2',
    );
    expect(normalizeTeamsJid('')).toBeNull();
    expect(teamsConversationIdFromJid('teams:19:abc@thread.v2')).toBe(
      '19:abc@thread.v2',
    );
    expect(teamsConversationIdFromJid('sl:C123')).toBeNull();
  });
});

describe('Teams Adaptive Card payloads', () => {
  it('reads external card action payloads from Teams adaptiveCard/action invokes', () => {
    const data = {
      action: 'external_card_action',
      integrationId: 'integration-test',
      eventId: 'outbox-1',
      resourceId: 'tender-1',
      workspaceId: 'workspace-1',
      sourceChannelId: '19:abc@thread.v2',
      teamsTenantId: 'tenant-1',
      actionType: 'watch',
      platformOperation: 'mark_resource',
      nonce: 'nonce-1',
      expiresAt: '2026-05-01T00:00:00.000Z',
      signature: 'signature',
    };

    const { action: _action, ...expectedAction } = data;
    expect(
      _testExternalCardActions.readExternalCardAction({
        action: {
          type: 'Action.Submit',
          data,
        },
        trigger: 'manual',
      }),
    ).toEqual(expect.objectContaining(expectedAction));
  });

  it('explains external card action parse misses without logging payload values', () => {
    expect(
      _testExternalCardActions.describeExternalCardActionParseMiss({
        action: {
          type: 'Action.Submit',
          data: {
            action: 'external_card_action',
            eventId: 'outbox-1',
          },
        },
        trigger: 'manual',
      }),
    ).toEqual({
      reason:
        'missing_fields:integrationId,resourceId,workspaceId,sourceChannelId,teamsTenantId,actionType,platformOperation,nonce,expiresAt,signature',
      valueKeys: ['action', 'trigger'],
      dataKeys: ['action', 'eventId'],
    });
  });

  it('calls external platform card actions with the conversation service actor and channel scope', () => {
    const request = buildExternalCardActionGraphqlRequest({
      action: {
        integrationId: 'integration-test',
        eventId: 'outbox-1',
        resourceId: 'tender-1',
        workspaceId: 'workspace-1',
        sourceChannelId: '19:abc@thread.v2',
        teamsTenantId: 'tenant-1',
        actionType: 'watch',
        platformOperation: 'mark_resource',
        nonce: 'nonce-1',
        expiresAt: '2026-05-01T00:00:00.000Z',
        signature: 'signature',
      },
      actorId: 'teams-user-1',
      teamsTenantId: 'tenant-1',
      occurredAt: '2026-04-30T00:00:00.000Z',
    });

    expect(request.headers).toEqual(
      expect.objectContaining({
        authorization: 'Bearer service:agent_conversation',
        'x-channel-id': '19:abc@thread.v2',
        'x-integration-id': 'integration-test',
      }),
    );
    expect(request.body.variables.input).toEqual(
      expect.objectContaining({
        integrationId: 'integration-test',
        eventId: 'outbox-1',
        resourceId: 'tender-1',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'workspace-1',
        sourceChannelId: '19:abc@thread.v2',
        teamsTenantId: 'tenant-1',
        platformOperation: 'mark_resource',
        actorId: 'teams-user-1',
        nonce: 'nonce-1',
      }),
    );
  });

  it('canonicalizes Teams invoke conversation ids with message suffixes', () => {
    expect(
      _testExternalCardActions.canonicalTeamsConversationId(
        '19:abc@thread.tacv2;messageid=1779532839539',
      ),
    ).toBe('19:abc@thread.tacv2');
    expect(
      _testExternalCardActions.canonicalTeamsConversationId(
        '19:abc@thread.tacv2',
      ),
    ).toBe('19:abc@thread.tacv2');
  });

  it('verifies external card actions when Teams rewrites equivalent expiresAt strings', () => {
    const previousSecret = process.env.GANTRY_EXTERNAL_ACTION_SECRET;
    process.env.GANTRY_EXTERNAL_ACTION_SECRET = 'secret';
    const signature = signExternalCardActionForVerification({
      secret: 'secret',
      integrationId: 'integration-test',
      eventId: 'outbox-1',
      resourceId: 'tender-1',
      workspaceId: 'workspace-1',
      sourceChannelId: '19:abc@thread.v2',
      teamsTenantId: 'tenant-1',
      actionType: 'request_analysis',
      platformOperation: 'requestAdminProcessingApproval',
      signatureVersion: 'v2',
      nonce: 'nonce-1',
      expiresAt: '2099-01-01T00:00:00.550Z',
    });

    try {
      expect(() =>
        _testExternalCardActions.verifyExternalCardActionSignature({
          integrationId: 'integration-test',
          eventId: 'outbox-1',
          resourceId: 'tender-1',
          workspaceId: 'workspace-1',
          sourceChannelId: '19:abc@thread.v2',
          teamsTenantId: 'tenant-1',
          actionType: 'request_analysis',
          platformOperation: 'requestAdminProcessingApproval',
          signatureVersion: 'v2',
          nonce: 'nonce-1',
          expiresAt: '2099-01-01T00:00:00.55Z',
          signature,
        }),
      ).not.toThrow();
      expect(() =>
        _testExternalCardActions.verifyExternalCardActionSignature({
          integrationId: 'integration-test',
          eventId: 'outbox-1',
          resourceId: 'tender-1',
          workspaceId: 'workspace-1',
          sourceChannelId: '19:abc@thread.v2',
          teamsTenantId: 'tenant-1',
          actionType: 'request_analysis',
          platformOperation: 'markTenderWatching',
          signatureVersion: 'v2',
          nonce: 'nonce-1',
          expiresAt: '2099-01-01T00:00:00.55Z',
          signature,
        }),
      ).toThrow('Invalid card action signature');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.GANTRY_EXTERNAL_ACTION_SECRET;
      } else {
        process.env.GANTRY_EXTERNAL_ACTION_SECRET = previousSecret;
      }
    }
  });

  it('builds Action.Execute allow-once and cancel actions', () => {
    const payload = buildTeamsApprovalDescriptorPayload({
      requestId: 'perm-1',
      sourceAgentFolder: 'teams_main',
      targetJid: 'teams:19:abc@thread.v2',
      threadId: 'root-message',
      toolName: 'Bash',
      toolInput: {
        command: 'git status --short',
      },
    });

    expect(payload.attachments[0].contentType).toBe(
      TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
    );
    expect(payload.attachments[0].content.actions).toEqual([
      expect.objectContaining({
        type: 'Action.Execute',
        title: 'Allow once',
        verb: 'gantry.permission.allow',
        data: expect.objectContaining({
          requestId: 'perm-1',
          decision: 'allow_once',
        }),
      }),
      expect.objectContaining({
        type: 'Action.Execute',
        title: 'Allow 5 min',
        verb: 'gantry.permission.allow',
        data: expect.objectContaining({
          requestId: 'perm-1',
          decision: 'allow_timed_grant',
        }),
      }),
      expect.objectContaining({
        type: 'Action.Execute',
        title: 'Cancel',
        verb: 'gantry.permission.cancel',
        data: expect.objectContaining({
          requestId: 'perm-1',
          decision: 'cancel',
        }),
      }),
    ]);
    expect(JSON.stringify(payload)).toContain('git status --short');
  });
});

describe('TeamsChannel adapter scaffold', () => {
  it('renders todo cards in the active Teams thread', async () => {
    let messageCounter = 0;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: `todo-${++messageCounter}`,
      })),
      updateAdaptiveCard: vi.fn(async () => ({})),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect({ inbound: false });

    await channel.renderAgentTodo('teams:19:abc@thread.v2', {
      threadId: 'reply-a',
      items: [{ id: '1', title: 'First', status: 'pending' }],
    });
    await channel.renderAgentTodo('teams:19:abc@thread.v2', {
      threadId: 'reply-b',
      items: [{ id: '2', title: 'Second', status: 'pending' }],
    });
    await channel.renderAgentTodo('teams:19:abc@thread.v2', {
      threadId: 'reply-a',
      items: [{ id: '1', title: 'First', status: 'completed' }],
    });

    expect(sdkClient.sendAdaptiveCard).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ threadId: 'reply-a' }),
    );
    expect(sdkClient.sendAdaptiveCard).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ threadId: 'reply-b' }),
    );
    expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'todo-1',
        threadId: 'reply-a',
      }),
    );
  });

  it('normalizes inbound Teams SDK messages and sends outbound through the seam', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
    };
    const opts = makeOpts();
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      opts,
      sdkClient,
    );

    await channel.connect();

    expect(channel.isConnected()).toBe(true);
    expect(sdkClient.start).toHaveBeenCalledWith({
      credentials: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      onMessage: expect.any(Function),
    });

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      id: 'activity-1',
      text: 'hello from Teams',
      from: {
        id: 'user-1',
        name: 'Ravi',
      },
      timestamp: '2026-04-30T00:00:00.000Z',
      threadId: 'root-message',
      conversationName: 'Engineering',
      conversationType: 'channel',
    });

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'teams:19:abc@thread.v2',
      '2026-04-30T00:00:00.000Z',
      'Engineering',
      'teams',
      true,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'teams:19:abc@thread.v2',
      expect.objectContaining({
        id: 'activity-1',
        chat_jid: 'teams:19:abc@thread.v2',
        provider: 'teams',
        sender: 'user-1',
        sender_name: 'Ravi',
        content: 'hello from Teams',
        thread_id: 'root-message',
      }),
    );

    await expect(
      channel.sendMessage('teams:19:abc@thread.v2', 'response', {
        threadId: 'root-message',
      }),
    ).resolves.toEqual(
      expect.objectContaining({ externalMessageId: 'teams-msg-1' }),
    );
    expect(sdkClient.sendMessage).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      text: 'response',
      threadId: 'root-message',
    });

    await channel.disconnect();

    expect(channel.isConnected()).toBe(false);
    expect(sdkClient.stop).toHaveBeenCalled();
  });

  it('starts the SDK for outbound messages without processing inbound activities in outbound-only mode', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
    };
    const opts = makeOpts();
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      opts,
      sdkClient,
    );

    await channel.connect({ inbound: false });

    expect(channel.isConnected()).toBe(true);
    expect(sdkClient.start).toHaveBeenCalledWith({
      credentials: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      onMessage: expect.any(Function),
    });
    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      id: 'ignored-activity',
      text: 'ignored',
      from: { id: 'user-1', name: 'Ravi' },
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
    await expect(
      channel.sendMessage('teams:19:abc@thread.v2', 'scheduler done'),
    ).resolves.toEqual(
      expect.objectContaining({ externalMessageId: 'teams-msg-1' }),
    );
    expect(sdkClient.sendMessage).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      text: 'scheduler done',
    });

    await channel.disconnect();

    expect(channel.isConnected()).toBe(false);
    expect(sdkClient.stop).toHaveBeenCalled();
  });

  it('splits large Teams outbound text and returns delivery part metadata', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async ({ text }) => ({
        externalMessageId: `teams:${text.length}`,
      })),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    const result = await channel.sendMessage(
      'teams:19:abc@thread.v2',
      'x'.repeat(90000),
    );

    expect(sdkClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(sdkClient.sendMessage).mock.calls[0]?.[0].text.length,
    ).toBeLessThanOrEqual(90000);
    expect(result).toEqual(
      expect.objectContaining({
        deliveredParts: 2,
        totalParts: 2,
        warnings: ['teams.message.chunked:2:79872'],
      }),
    );
  });

  it('retries Teams outbound payloads by splitting after 413 errors', async () => {
    const sendMessage = vi
      .fn(async () => ({ externalMessageId: 'unused' }))
      .mockRejectedValueOnce({ status: 413, message: 'payload too large' })
      .mockResolvedValueOnce({ externalMessageId: 'teams-msg-a' })
      .mockResolvedValueOnce({ externalMessageId: 'teams-msg-b' });
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage,
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    const result = await channel.sendMessage(
      'teams:19:abc@thread.v2',
      'x'.repeat(10000),
    );

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(result).toEqual(
      expect.objectContaining({
        deliveredParts: 2,
        totalParts: 2,
        warnings: ['teams.payload_413_split_retry'],
      }),
    );
  });

  it('retries Teams 413 payloads with code-point-safe byte-budget splits', async () => {
    const emojiHeavy = '🙂'.repeat(2501);
    const sendMessage = vi
      .fn(async () => ({ externalMessageId: 'teams-msg' }))
      .mockRejectedValueOnce({ status: 413, message: 'payload too large' });
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage,
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    const result = await channel.sendMessage(
      'teams:19:abc@thread.v2',
      emojiHeavy,
    );

    expect(sendMessage).toHaveBeenCalledTimes(4);
    const retryParts = vi
      .mocked(sendMessage)
      .mock.calls.slice(1)
      .map(([input]) => input.text);
    expect(retryParts.join('')).toBe(emojiHeavy);
    for (const part of retryParts) {
      expect(part).not.toContain('\uFFFD');
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(5002);
      const firstCodeUnit = part.charCodeAt(0);
      const lastCodeUnit = part.charCodeAt(part.length - 1);
      expect(firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff).toBe(false);
      expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
    }
    expect(result).toEqual(
      expect.objectContaining({
        deliveredParts: 3,
        totalParts: 3,
        warnings: ['teams.payload_413_split_retry'],
      }),
    );
  });

  it('throws partial delivery classification when a later Teams chunk fails', async () => {
    const sendMessage = vi
      .fn(async ({ text }) => ({ externalMessageId: `teams:${text.length}` }))
      .mockResolvedValueOnce({ externalMessageId: 'teams-msg-a' })
      .mockRejectedValueOnce(new Error('second part failed'));
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage,
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    let thrown: unknown;
    try {
      await channel.sendMessage('teams:19:abc@thread.v2', 'x'.repeat(90000));
    } catch (err) {
      thrown = err;
    }
    const unsentSuffix = vi.mocked(sendMessage).mock.calls[1]?.[0]?.text;
    expect(thrown).toMatchObject({
      name: 'PartialTeamsDeliveryError',
      partialMessageDelivery: true,
      deliveredChunks: 1,
      totalChunks: 2,
      retryTail: {
        canonicalText: unsentSuffix,
        providerPayload: expect.objectContaining({
          provider: 'teams',
          conversationId: '19:abc@thread.v2',
        }),
      },
    });
  });

  it('sends Teams approval cards and accepts Action.Execute decisions from conversation approvers', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const isControlApproverAllowed = vi.fn(async () => true);
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'teams-card-1',
      })),
    };
    const opts = {
      ...makeOpts(),
      isControlApproverAllowed,
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      opts,
      sdkClient,
    );
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      {
        requestId: 'perm-teams-1',
        sourceAgentFolder: 'teams_engineering',
        decisionPolicy: 'same_channel',
        toolName: 'Bash',
        threadId: 'root-message',
      },
    );

    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:abc@thread.v2',
        threadId: 'root-message',
      }),
    );
    await Promise.resolve();

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        action: 'permission_decision',
        requestId: 'perm-teams-1',
        decision: 'allow_once',
      },
    });

    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({
        approved: true,
        decidedBy: 'Team Admin',
      }),
    );
    expect(isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'teams',
        conversationJid: 'teams:19:abc@thread.v2',
        userId: 'teams-user-1',
      }),
    );
  });

  it('sends Teams user-question cards and resolves Action.Submit answers from approvers', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const isControlApproverAllowed = vi.fn(async () => true);
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({ externalMessageId: 'teams-q-1' })),
    };
    const opts = { ...makeOpts(), isControlApproverAllowed };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      opts,
      sdkClient,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('teams:19:abc@thread.v2', {
      requestId: 'q-teams-1',
      sourceAgentFolder: 'teams_engineering',
      questions: [
        {
          question: 'Which environment?',
          header: 'Env',
          multiSelect: false,
          options: [
            { label: 'staging', description: 'pre-prod' },
            { label: 'production', description: 'live' },
          ],
        },
      ],
    });

    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: '19:abc@thread.v2' }),
    );
    await Promise.resolve();

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        action: 'gantry_userq',
        requestId: 'q-teams-1',
        gantry_userq_choice_0: '1',
        gantry_userq_other_0: '',
      },
    });

    await expect(answerPromise).resolves.toEqual({
      requestId: 'q-teams-1',
      answers: { 'Which environment?': 'production' },
      answeredBy: 'Team Admin',
    });
    expect(isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'teams',
        conversationJid: 'teams:19:abc@thread.v2',
        userId: 'teams-user-1',
      }),
    );
  });

  it('resolves durable Teams user-question answers after restart', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const isControlApproverAllowed = vi.fn(async () => true);
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({ externalMessageId: 'teams-q-1' })),
    };
    const request = {
      requestId: 'q-teams-restart',
      sourceAgentFolder: 'teams_engineering',
      targetJid: 'teams:19:abc@thread.v2',
      questions: [
        {
          question: 'Which environment?',
          header: 'Env',
          multiSelect: false,
          options: [
            { label: 'staging', description: 'pre-prod' },
            { label: 'production', description: 'live' },
          ],
        },
      ],
    };
    const pending = {
      id: 'pending-question-1',
      appId: 'default',
      runId: 'run-1',
      kind: 'question',
      status: 'pending',
      payload: {
        requestId: request.requestId,
        sourceAgentFolder: request.sourceAgentFolder,
        targetJid: request.targetJid,
        request,
      },
      callbackRoute: null,
      idempotencyKey: 'question:teams_engineering:q-teams-restart',
      approverRef: null,
      resolution: null,
      createdAt: '2026-06-18T00:00:00.000Z',
      expiresAt: '2026-06-19T00:00:00.000Z',
      resolvedAt: null,
    };
    const repository = {
      listPendingInteractions: vi.fn(async () => [pending]),
      resolvePendingInteraction: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({ repository: repository as never });
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      { ...makeOpts(), isControlApproverAllowed },
      sdkClient,
    );
    await channel.connect();

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        action: 'gantry_userq',
        requestId: 'q-teams-restart',
        gantry_userq_choice_0: '1',
        gantry_userq_other_0: '',
      },
    });

    expect(repository.resolvePendingInteraction).toHaveBeenCalledWith({
      idempotencyKey: 'question:teams_engineering:q-teams-restart',
      status: 'resolved',
      resolution: { answers: { 'Which environment?': 'production' } },
      approverRef: 'Team Admin',
    });
    expect(isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'teams',
        conversationJid: 'teams:19:abc@thread.v2',
        userId: 'teams-user-1',
      }),
    );
  });

  it('keeps pending Teams permission prompts unresolved when decision user is unauthorized', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const isControlApproverAllowed = vi.fn(async () => false);
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'teams-card-2',
      })),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      {
        ...makeOpts(),
        isControlApproverAllowed,
      },
      sdkClient,
    );
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      {
        requestId: 'perm-teams-unauthorized',
        sourceAgentFolder: 'teams_engineering',
        decisionPolicy: 'same_channel',
        toolName: 'Bash',
      },
    );
    await Promise.resolve();

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-2', name: 'Viewer' },
      value: {
        data: {
          action: 'permission_decision',
          requestId: 'perm-teams-unauthorized',
          decision: 'allow_once',
        },
      },
    });

    let settled = false;
    void approvalPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(sdkClient.sendMessage).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      text: 'You are not allowed to decide this permission request.',
    });

    await channel.disconnect();
    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({
        approved: false,
        decidedBy: 'system',
        reason: 'Teams channel disconnected',
      }),
    );
  });

  it('creates a channel only when runtime secrets and an SDK client are supplied', () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
    };

    expect(createTeamsChannel(makeOpts(), { sdkClient })).toBeInstanceOf(
      TeamsChannel,
    );
  });
});
