import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildExternalPlatformDelivery,
  buildExternalPlatformMessage,
  resolveExternalDeliveryRetryDelayMs,
  signGantryDeliveryStatusRequest,
  signExternalEventRequest,
  verifyExternalEventSignature,
} from '@core/control/server/routes/external-platform-events.js';

const envelope = {
  integrationId: 'integration-test',
  eventId: 'outbox-1',
  eventType: 'notification.card.requested',
  occurredAt: '2026-05-18T10:00:00.000Z',
  target: {
    teamsChannelId: '19:channel@thread.v2',
  },
  payload: {
    eventType: 'notification.card.requested',
    resourceId: 'resource-1',
    title: 'MRI scanner maintenance tender',
    referenceNo: 'MPL-001',
    organization: 'External Hospital',
    deadline: '2026-05-31',
    sourceUrl: 'https://example.test/tender',
    documentAttachment: {
      downloadStatus: 'missing',
    },
    requestedAt: '2026-05-18T10:00:00.000Z',
  },
};

const cardEnvelope = {
  ...envelope,
  eventId: 'outbox-card-1',
  payload: {
    ...envelope.payload,
    notificationCard: {
      schemaVersion: 'external.notification.card.v1',
      renderer: 'gantry_adaptive_card',
      teamsCompatibility: {
        adaptiveCardVersion: '1.2',
        requiresBotForSubmitActions: true,
      },
      resourceId: 'resource-1',
      title: 'MRI scanner maintenance tender',
      referenceNo: 'MPL-001',
      organization: 'External Hospital',
      location: 'Bengaluru',
      deadline: '2026-05-31',
      publishedDate: '2026-05-18',
      emd: 50000,
      currency: 'INR',
      summary: 'Maintenance tender for matched biomedical workspace.',
      sourceUrl: 'https://example.test/tender',
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Biomedical',
        teamsChannelId: '19:channel@thread.v2',
        matchedKeywords: ['mri'],
      },
      primaryDocument: {
        signedDownloadUrl: 'https://example.test/documents/notice.pdf',
      },
      documents: [
        {
          documentLabel: 'notice.pdf',
          fileName: 'notice.pdf',
          downloadStatus: 'downloaded',
          signedDownloadUrl: 'https://example.test/documents/notice.pdf',
        },
        {
          documentLabel: 'missing.pdf',
          fileName: 'missing.pdf',
          downloadStatus: 'missing',
          signedDownloadUrl: null,
        },
      ],
      actions: [
        {
          actionType: 'mark_watching',
          label: 'Watch',
          presentation: 'submit',
          platformOperation: 'mark_resource',
          requiresActionCapableTeamsSurface: true,
        },
        {
          actionType: 'request_analysis',
          label: 'Request analysis',
          presentation: 'submit',
          platformOperation: 'request_analysis',
          requiresActionCapableTeamsSurface: true,
        },
      ],
      fallbackText: 'Tender notice: MRI scanner maintenance tender',
    },
  },
};

const adminNotificationEnvelope = {
  integrationId: 'integration-test',
  eventId: 'admin-outbox-1',
  eventType: 'deep_analysis_admin_notification_requested',
  occurredAt: '2026-05-18T10:00:00.000Z',
  payload: {
    eventType: 'deep_analysis_admin_notification_requested',
    requestId: 'request-1',
    tenderId: 'resource-1',
    tenderTitle: 'MRI scanner maintenance tender',
    workspaceId: 'workspace-1',
    workspaceName: 'Biomedical',
    requestedByExternalUserId: 'teams-user-1',
    requestedByDisplayName: 'Platform User',
    sourceChannelId: '19:channel@thread.v2',
    requestedAt: '2026-05-18T10:00:00.000Z',
    requestReason: 'Need deeper analysis',
  },
};

describe('External platform event adapter helpers', () => {
  beforeEach(() => {
    process.env.GANTRY_EXTERNAL_ACTION_SECRET = 'action-secret';
    process.env.GANTRY_EXTERNAL_TEAMS_TENANT_ID = 'tenant-1';
  });
  it('signs and verifies External event requests', () => {
    const rawBody = JSON.stringify(envelope);
    const signature = signExternalEventRequest({
      secret: 'secret',
      method: 'POST',
      path: '/v1/integrations/platform-events',
      timestamp: '1000',
      nonce: 'nonce-1',
      rawBody,
    });

    expect(
      verifyExternalEventSignature({
        secret: 'secret',
        method: 'POST',
        path: '/v1/integrations/platform-events',
        timestamp: '1000',
        nonce: 'nonce-1',
        rawBody,
        signature,
        nowMs: 1000,
      }),
    ).toBe(true);
    expect(
      verifyExternalEventSignature({
        secret: 'wrong',
        method: 'POST',
        path: '/v1/integrations/platform-events',
        timestamp: '1000',
        nonce: 'nonce-1',
        rawBody,
        signature,
        nowMs: 1000,
      }),
    ).toBe(false);
  });

  it('rejects stale timestamps', () => {
    const rawBody = JSON.stringify(envelope);
    const signature = signExternalEventRequest({
      secret: 'secret',
      method: 'POST',
      path: '/v1/integrations/platform-events',
      timestamp: '1000',
      nonce: 'nonce-1',
      rawBody,
    });

    expect(
      verifyExternalEventSignature({
        secret: 'secret',
        method: 'POST',
        path: '/v1/integrations/platform-events',
        timestamp: '1000',
        nonce: 'nonce-1',
        rawBody,
        signature,
        nowMs: 10 * 60_000,
      }),
    ).toBe(false);
  });

  it('builds deterministic Teams text for card notification events', () => {
    expect(buildExternalPlatformMessage(envelope)).toContain(
      'Notification: MRI scanner maintenance tender',
    );
    expect(buildExternalPlatformMessage(envelope)).toContain(
      'Organisation Details: External Hospital',
    );
    expect(buildExternalPlatformMessage(envelope)).not.toContain('Reference');
  });

  it('builds deterministic Teams text for admin deep-analysis requests', () => {
    const text = buildExternalPlatformMessage(adminNotificationEnvelope);
    expect(text).toContain('Deeper analysis requested');
    expect(text).toContain(
      'Platform User requested deeper analysis for MRI scanner maintenance tender.',
    );
    expect(text).toContain('Tender ID: resource-1');
    expect(text).toContain('Workspace: Biomedical');
    expect(text).toContain('Reason: Need deeper analysis');
  });

  it('builds an Adaptive Card delivery when notification card data is present', () => {
    const delivery = buildExternalPlatformDelivery(cardEnvelope);
    expect(delivery.kind).toBe('adaptive_card');
    if (delivery.kind !== 'adaptive_card') return;
    expect(delivery.card.version).toBe('1.2');
    expect(delivery.card.body[0]).toMatchObject({
      type: 'TextBlock',
      text: 'MRI scanner maintenance tender',
    });
    expect(JSON.stringify(delivery.card.body)).toContain('Tender ID');
    expect(JSON.stringify(delivery.card.body)).toContain('resource-1');
    expect(JSON.stringify(delivery.card.body)).toContain('EMD');
    expect(JSON.stringify(delivery.card.body)).toContain('INR 50,000');
    expect(JSON.stringify(delivery.card.body)).toContain('Workspace matched');
    expect(JSON.stringify(delivery.card.body)).toContain(
      'Organisation Details',
    );
    expect(JSON.stringify(delivery.card.body)).toContain('Location Details');
    expect(JSON.stringify(delivery.card.body)).toContain('Dead Line Date');
    expect(JSON.stringify(delivery.card.body)).toContain('Published Date');
    expect(JSON.stringify(delivery.card.body)).not.toContain('Reference');
    expect(JSON.stringify(delivery.card.body)).not.toContain(
      'Matched keywords',
    );
    expect(JSON.stringify(delivery.card.body)).toContain('Documents');
    expect(JSON.stringify(delivery.card.body)).toContain(
      '[notice.pdf](https://example.test/documents/notice.pdf)',
    );
    expect(delivery.card.actions).toEqual([
      {
        type: 'Action.Submit',
        title: 'Watch',
        data: expect.objectContaining({
          action: 'external_card_action',
          actionType: 'mark_watching',
          platformOperation: 'mark_resource',
          integrationId: 'integration-test',
          resourceId: 'resource-1',
          sourceChannelId: '19:channel@thread.v2',
          teamsTenantId: 'tenant-1',
          nonce: expect.any(String),
          expiresAt: expect.any(String),
          signature: expect.any(String),
        }),
      },
      {
        type: 'Action.Submit',
        title: 'Request analysis',
        data: expect.objectContaining({
          actionType: 'request_analysis',
          platformOperation: 'request_analysis',
        }),
      },
    ]);
  });

  it('renders document links in body text with escaping and URL validation', () => {
    const delivery = buildExternalPlatformDelivery({
      ...cardEnvelope,
      payload: {
        ...cardEnvelope.payload,
        notificationCard: {
          ...cardEnvelope.payload.notificationCard,
          documents: [
            {
              documentLabel: 'Spec [final] (v2).pdf',
              fileName: 'Spec [final] (v2).pdf',
              downloadStatus: 'downloaded',
              signedDownloadUrl: 'https://example.test/documents/spec(1).pdf',
            },
            {
              documentLabel: 'bad.pdf',
              fileName: 'bad.pdf',
              downloadStatus: 'downloaded',
              signedDownloadUrl: 'ftp://example.test/bad.pdf',
            },
            {
              documentLabel: 'missing.pdf',
              fileName: 'missing.pdf',
              downloadStatus: 'missing',
              signedDownloadUrl: null,
            },
            {
              documentLabel: 'boq.pdf',
              fileName: 'boq.pdf',
              downloadStatus: 'downloaded',
              signedDownloadUrl: 'https://example.test/documents/boq.pdf',
            },
          ],
        },
      },
    });
    expect(delivery.kind).toBe('adaptive_card');
    if (delivery.kind !== 'adaptive_card') return;

    const body = JSON.stringify(delivery.card.body);
    expect(body).toContain(
      '[Spec \\\\[final\\\\] \\\\(v2\\\\).pdf](https://example.test/documents/spec%281%29.pdf)',
    );
    expect(body).toContain('[boq.pdf](https://example.test/documents/boq.pdf)');
    expect(body).not.toContain('ftp://example.test/bad.pdf');
    expect(body).not.toContain('missing.pdf');
    expect(JSON.stringify(delivery.card.actions)).not.toContain(
      'Action.OpenUrl',
    );
  });

  it('omits submit actions when no Teams tenant id is available for signing', () => {
    delete process.env.GANTRY_EXTERNAL_TEAMS_TENANT_ID;
    delete process.env.TEAMS_TENANT_ID;

    const delivery = buildExternalPlatformDelivery(cardEnvelope);
    expect(delivery.kind).toBe('adaptive_card');
    if (delivery.kind !== 'adaptive_card') return;
    expect(JSON.stringify(delivery.card.body)).toContain(
      '[notice.pdf](https://example.test/documents/notice.pdf)',
    );
    expect(delivery.card.actions).toEqual([]);
  });

  it('signs External delivery status callbacks with the platform callback path', () => {
    const rawBody = JSON.stringify({
      eventId: 'outbox-1',
      status: 'delivered',
      deliveredAt: '2026-05-18T10:00:01.000Z',
      teamsMessageId: 'teams-message-1',
    });

    expect(
      signGantryDeliveryStatusRequest({
        secret: 'secret',
        method: 'POST',
        path: '/hooks/gantry/delivery-status',
        timestamp: '1000',
        nonce: 'nonce-1',
        rawBody,
      }),
    ).toBe(
      signExternalEventRequest({
        secret: 'secret',
        method: 'POST',
        path: '/hooks/gantry/delivery-status',
        timestamp: '1000',
        nonce: 'nonce-1',
        rawBody,
      }),
    );
  });

  it('backs off External delivery retries with a cap', () => {
    expect(resolveExternalDeliveryRetryDelayMs(0)).toBe(5000);
    expect(resolveExternalDeliveryRetryDelayMs(1)).toBe(10000);
    expect(resolveExternalDeliveryRetryDelayMs(20)).toBe(60000);
  });
});
