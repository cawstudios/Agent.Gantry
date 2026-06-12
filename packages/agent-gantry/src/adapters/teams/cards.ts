import type { GantryExternalNotificationAdaptiveCardInput } from './types.js';
import { signExternalCardAction } from './signing.js';
import {
  asRecord,
  readOptionalNumberOrString,
  readOptionalString,
} from '../../shared/helpers.js';

export function buildExternalNotificationAdaptiveCard(
  input: GantryExternalNotificationAdaptiveCardInput,
): Record<string, unknown> | null {
  const card = readNotificationCard(input.payload.notificationCard);
  if (!card) return null;
  const resourceId =
    readOptionalString(card.resourceId) ??
    readOptionalString(input.payload.resourceId);
  const facts = [
    adaptiveFact('Tender ID', resourceId),
    adaptiveFact('EMD', formatNotificationAmount(card.emd, card.currency)),
    adaptiveFact('Workspace matched', card.workspace?.workspaceName),
    adaptiveFact('Organisation Details', card.organization),
    adaptiveFact('Location Details', card.location),
    adaptiveFact('Dead Line Date', card.deadline),
    adaptiveFact('Published Date', card.publishedDate),
  ].filter((entry): entry is { title: string; value: string } =>
    Boolean(entry),
  );
  const summary = sanitizeNotificationSummary(card.summary ?? null);
  const body: Record<string, unknown>[] = [
    {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      text: card.title,
      wrap: true,
    },
    ...(summary ? [{ type: 'TextBlock', text: summary, wrap: true }] : []),
    ...(facts.length ? [{ type: 'FactSet', facts }] : []),
    ...buildDocumentLinkBlocks(card),
  ];

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.2',
    body,
    actions: readNotificationActions(card.actions)
      .filter((action) => action.presentation === 'submit')
      .map((action) => buildTeamsSubmitAction(input, card, action, resourceId))
      .filter((action): action is Record<string, unknown> => Boolean(action)),
  };
}

type NotificationCardAction = {
  readonly actionType: string;
  readonly label: string;
  readonly presentation: string;
  readonly url?: string | null;
  readonly platformOperation?: string | null;
};

type NotificationCard = {
  readonly title: string;
  readonly resourceId?: string | null;
  readonly organization?: string | null;
  readonly location?: string | null;
  readonly deadline?: string | null;
  readonly publishedDate?: string | null;
  readonly emd?: number | string | null;
  readonly currency?: string | null;
  readonly summary?: string | null;
  readonly workspace?: {
    readonly workspaceId?: string | null;
    readonly workspaceName?: string | null;
    readonly teamsChannelId?: string | null;
    readonly teamsTenantId?: string | null;
  };
  readonly documents?: unknown;
  readonly actions?: unknown;
};

function readNotificationCard(value: unknown): NotificationCard | null {
  if (!value || typeof value !== 'object') return null;
  const card = value as Record<string, unknown>;
  if (
    card.schemaVersion !== 'external.notification.card.v1' ||
    card.renderer !== 'gantry_adaptive_card' ||
    !readOptionalString(card.title)
  ) {
    return null;
  }
  return {
    title: readOptionalString(card.title) ?? 'New notification',
    resourceId: readOptionalString(card.resourceId),
    organization: readOptionalString(card.organization),
    location: readOptionalString(card.location),
    deadline: readOptionalString(card.deadline),
    publishedDate: readOptionalString(card.publishedDate),
    emd: readOptionalNumberOrString(card.emd),
    currency: readOptionalString(card.currency),
    summary: readOptionalString(card.summary),
    workspace:
      card.workspace && typeof card.workspace === 'object'
        ? (card.workspace as NotificationCard['workspace'])
        : undefined,
    documents: Array.isArray(card.documents) ? card.documents : [],
    actions: card.actions,
  };
}

function readNotificationActions(value: unknown): NotificationCardAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const action = entry as Record<string, unknown>;
    const actionType = readOptionalString(action.actionType);
    const label = readOptionalString(action.label);
    const presentation = readOptionalString(action.presentation);
    if (!actionType || !label || !presentation) return [];
    return [
      {
        actionType,
        label,
        presentation,
        url: readOptionalString(action.url),
        platformOperation: readOptionalString(action.platformOperation),
      },
    ];
  });
}

function buildTeamsSubmitAction(
  input: GantryExternalNotificationAdaptiveCardInput,
  card: NotificationCard,
  action: NotificationCardAction,
  resourceId: string | null,
): Record<string, unknown> | null {
  const platformOperation = readOptionalString(action.platformOperation);
  const workspaceId = readOptionalString(card.workspace?.workspaceId);
  const sourceChannelId = readOptionalString(card.workspace?.teamsChannelId);
  const teamsTenantId =
    readOptionalString(card.workspace?.teamsTenantId) ??
    readOptionalString(input.target?.teamsTenantId);
  if (
    !platformOperation ||
    !resourceId ||
    !workspaceId ||
    !sourceChannelId ||
    !teamsTenantId
  ) {
    return null;
  }
  return {
    type: 'Action.Submit',
    title: action.label,
    data: {
      action: 'external_card_action',
      actionType: action.actionType,
      platformOperation,
      integrationId: input.integrationId,
      eventId: input.eventId,
      resourceId,
      workspaceId,
      sourceWorkspaceId: workspaceId,
      sourceChannelId,
      teamsTenantId,
      ...signExternalCardAction({
        secret: input.actionSecret,
        integrationId: input.integrationId,
        eventId: input.eventId,
        resourceId,
        workspaceId,
        sourceChannelId,
        teamsTenantId,
        actionType: action.actionType,
        nowMs: input.nowMs,
      }),
    },
  };
}

function buildDocumentLinkBlocks(
  card: NotificationCard,
): Record<string, unknown>[] {
  if (!Array.isArray(card.documents)) return [];
  const links = card.documents
    .flatMap((entry, index): string[] => {
      if (!entry || typeof entry !== 'object') return [];
      const document = entry as Record<string, unknown>;
      const url = normalizeHttpUrl(document.signedDownloadUrl);
      if (!url) return [];
      const label =
        readOptionalString(document.documentLabel) ??
        readOptionalString(document.fileName) ??
        `Document ${index + 1}`;
      return [
        `[${escapeMarkdownLinkLabel(label)}](${escapeMarkdownLinkUrl(url)})`,
      ];
    })
    .slice(0, 5);
  if (links.length === 0) return [];
  return [
    {
      type: 'TextBlock',
      text: 'Documents',
      weight: 'Bolder',
      wrap: true,
      spacing: 'Medium',
    },
    { type: 'TextBlock', text: links.join('\n'), wrap: true, spacing: 'Small' },
  ];
}

function adaptiveFact(
  title: string,
  value: string | null | undefined,
): { title: string; value: string } | null {
  const normalized = readOptionalString(value);
  return normalized ? { title, value: normalized } : null;
}

function formatNotificationAmount(
  amount: number | string | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (amount === null || amount === undefined || amount === '') return null;
  return typeof amount === 'number'
    ? `${currency || 'INR'} ${amount.toLocaleString('en-IN')}`
    : amount;
}

function normalizeHttpUrl(value: unknown): string | null {
  const raw = readOptionalString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function escapeMarkdownLinkLabel(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\[\]()])/g, '\\$1');
}

function escapeMarkdownLinkUrl(value: string): string {
  return value.replace(/[()]/g, (character) =>
    character === '(' ? '%28' : '%29',
  );
}

function sanitizeNotificationSummary(value: string | null): string | null {
  const lines =
    value
      ?.split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(
        (line) =>
          line &&
          !notificationSummaryNoisePatterns.some((pattern) =>
            pattern.test(line),
          ),
      ) ?? [];
  const summary = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (!summary || summary.length < 12) return null;
  return summary.length > 420
    ? `${summary.slice(0, 417).trimEnd()}...`
    : summary;
}

const notificationSummaryNoisePatterns = [
  /^screen reader access$/i,
  /^search\s*\|/i,
  /active tenders/i,
  /corrigendum/i,
  /results of tenders/i,
  /^text$/i,
  /^basic details$/i,
  /^mis reports$/i,
  /^tenders by /i,
  /^tenders in archive$/i,
  /^tenders status$/i,
  /^cancelled\/retendered$/i,
  /^downloads$/i,
  /^department list$/i,
  /^announcements$/i,
  /^recognitions$/i,
  /^site compatibility$/i,
  /^view more details$/i,
  /^tender details$/i,
  /eprocurement system/i,
];
