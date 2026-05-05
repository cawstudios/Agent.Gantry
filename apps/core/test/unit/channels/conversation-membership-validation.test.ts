import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeSecretConversationMembershipValidator } from '@core/channels/conversation-membership-validation.js';

const iso = '2026-05-01T00:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RuntimeSecretConversationMembershipValidator', () => {
  it('blocks unsupported provider membership validation with availability guidance', async () => {
    const validator = new RuntimeSecretConversationMembershipValidator({
      getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error(`missing ${ref.env}`);
        return value;
      },
      getOptionalSecret() {
        return undefined;
      },
    });

    const result = await validator.validateControlApprovers({
      providerId: 'whatsapp' as never,
      providerConnection: {
        id: 'providerConnection-unsupported',
        appId: 'default' as never,
        providerId: 'whatsapp' as never,
        label: 'WhatsApp',
        status: 'active',
        config: {},
        runtimeSecretRefs: [],
        createdAt: iso,
        updatedAt: iso,
      },
      conversation: {
        id: 'conversation-unsupported' as never,
        appId: 'default' as never,
        providerConnectionId: 'providerConnection-unsupported' as never,
        externalRef: { kind: 'conversation', value: 'wa:chat' },
        kind: 'channel',
        title: 'Unsupported',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      },
      userIds: ['user-one'],
    });

    expect(result).toEqual({
      validUserIds: [],
      invalidUserIds: ['user-one'],
      reason: 'whatsapp conversation membership validation is not available.',
    });
  });

  it('validates Teams approvers through Microsoft Graph conversation members', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'graph-token' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'membership-1',
                userId: 'teams-user-1',
                email: 'admin@example.com',
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const validator = new RuntimeSecretConversationMembershipValidator({
      getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error(`missing ${ref.env}`);
        return value;
      },
      getOptionalSecret(ref) {
        return {
          TEAMS_CLIENT_ID: 'client-id',
          TEAMS_CLIENT_SECRET: 'client-secret',
          TEAMS_TENANT_ID: 'tenant-id',
        }[ref.env];
      },
    });

    const result = await validator.validateControlApprovers({
      providerId: 'teams' as never,
      providerConnection: {
        id: 'providerConnection-1',
        appId: 'default' as never,
        providerId: 'teams' as never,
        label: 'Teams',
        status: 'active',
        config: {},
        runtimeSecretRefs: [
          'TEAMS_CLIENT_ID',
          'TEAMS_CLIENT_SECRET',
          'TEAMS_TENANT_ID',
        ],
        createdAt: iso,
        updatedAt: iso,
      },
      conversation: {
        id: 'conversation-1' as never,
        appId: 'default' as never,
        providerConnectionId: 'providerConnection-1' as never,
        externalRef: { kind: 'conversation', value: 'teams:19:abc@thread.v2' },
        kind: 'channel',
        title: 'Engineering',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      },
      userIds: ['teams-user-1', 'outsider-1'],
    });

    expect(result).toEqual({
      validUserIds: ['teams-user-1'],
      invalidUserIds: ['outsider-1'],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.v2/members',
      expect.objectContaining({
        headers: { authorization: 'Bearer graph-token' },
      }),
    );
  });

  it('uses Teams channel membership endpoint and follows pagination when team and channel IDs are configured', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'graph-token' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ userId: 'teams-user-1' }],
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/next-page-token',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ userPrincipalName: 'teams-user-2' }],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const validator = new RuntimeSecretConversationMembershipValidator({
      getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error(`missing ${ref.env}`);
        return value;
      },
      getOptionalSecret(ref) {
        return {
          TEAMS_CLIENT_ID: 'client-id',
          TEAMS_CLIENT_SECRET: 'client-secret',
          TEAMS_TENANT_ID: 'tenant-id',
        }[ref.env];
      },
    });

    const result = await validator.validateControlApprovers({
      providerId: 'teams' as never,
      providerConnection: {
        id: 'providerConnection-2',
        appId: 'default' as never,
        providerId: 'teams' as never,
        label: 'Teams',
        status: 'active',
        config: {
          teamId: 'team-1',
          channelId: 'channel-1',
        },
        runtimeSecretRefs: [
          'TEAMS_CLIENT_ID',
          'TEAMS_CLIENT_SECRET',
          'TEAMS_TENANT_ID',
        ],
        createdAt: iso,
        updatedAt: iso,
      },
      conversation: {
        id: 'conversation-2' as never,
        appId: 'default' as never,
        providerConnectionId: 'providerConnection-2' as never,
        externalRef: { kind: 'conversation', value: 'teams:19:def@thread.v2' },
        kind: 'channel',
        title: 'Design',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      },
      userIds: ['teams-user-1', 'teams-user-2', 'outsider-1'],
    });

    expect(result).toEqual({
      validUserIds: ['teams-user-1', 'teams-user-2'],
      invalidUserIds: ['outsider-1'],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/members',
      expect.objectContaining({
        headers: { authorization: 'Bearer graph-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://graph.microsoft.com/v1.0/next-page-token',
      expect.objectContaining({
        headers: { authorization: 'Bearer graph-token' },
      }),
    );
  });
});
