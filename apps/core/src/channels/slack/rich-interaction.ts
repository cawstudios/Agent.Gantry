import type { RichInteractionRequest } from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { slackThreadTsFromThreadId } from './thread-ts.js';
import {
  isRichForm,
  richDescriptor,
  RICH_INTERACTION_CANCEL_LABEL,
  RICH_INTERACTION_FALLBACK_COPY,
  RICH_INTERACTION_OPEN_FORM_LABEL,
  RICH_INTERACTION_REQUIRED_FIELDS_COPY,
  RICH_INTERACTION_SUBMIT_LABEL,
  RICH_INTERACTION_SUBMITTED_BY_COPY,
  richFallbackText,
  richSlackEscape,
  richTextLines,
  richTruncate,
} from '../rich-interaction.js';

export function buildSlackRichInteractionBlocks(
  input: RichInteractionRequest,
): Array<Record<string, unknown>> {
  const item = richDescriptor(input);
  const richLines = richTextLines(input);
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: richTruncate(item.title, 150),
        emoji: true,
      },
    },
  ];
  const body = richLines.slice(1).join('\n');
  if (body) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: richTruncate(richSlackEscape(body), 2900) },
    });
  }
  if (item.details?.length) {
    blocks.push({
      type: 'section',
      fields: item.details.slice(0, 10).map((detail) => ({
        type: 'mrkdwn',
        text: `*${richSlackEscape(detail.label)}*\n${richSlackEscape(detail.value)}`,
      })),
    });
  }
  if (item.actions?.length) {
    blocks.push({
      type: 'actions',
      elements: item.actions.slice(0, 5).map((action) => ({
        type: 'button',
        text: {
          type: 'plain_text',
          text: richTruncate(action.label, 75),
          emoji: true,
        },
        action_id: `gantry_rich_${action.id}`,
        value: JSON.stringify({ interactionId: item.id, actionId: action.id }),
        style:
          action.style === 'danger'
            ? 'danger'
            : action.style === 'primary'
              ? 'primary'
              : undefined,
      })),
    });
  }
  if (isRichForm(input)) {
    blocks.push(
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: richSlackEscape(RICH_INTERACTION_REQUIRED_FIELDS_COPY),
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: RICH_INTERACTION_OPEN_FORM_LABEL,
              emoji: true,
            },
            action_id: 'gantry_rich_form_open',
            value: item.id,
            style: 'primary',
          },
        ],
      },
    );
  }
  return blocks;
}

export async function renderSlackRichInteraction(input: {
  app: any;
  jid: string;
  channelId: string;
  render: RichInteractionRequest;
  pendingRichForms: Map<string, RichInteractionRequest>;
  sendFallback: (
    text: string,
    options: { threadId?: string },
  ) => Promise<unknown>;
}): Promise<boolean> {
  const { app, jid, channelId, render, pendingRichForms, sendFallback } = input;
  try {
    if (isRichForm(render)) pendingRichForms.set(render.descriptor.id, render);
    await app.client.chat.postMessage({
      channel: channelId,
      text: richFallbackText(render),
      blocks: buildSlackRichInteractionBlocks(render) as any,
      ...(slackThreadTsFromThreadId(render.threadId)
        ? { thread_ts: slackThreadTsFromThreadId(render.threadId) }
        : {}),
    });
    return true;
  } catch (err) {
    logger.warn({ jid, err }, 'Slack rich interaction render failed');
    await sendFallback(
      `${RICH_INTERACTION_FALLBACK_COPY}\n\n${richFallbackText(render)}`,
      { threadId: render.threadId },
    );
    return true;
  }
}

export function registerSlackRichFormHandlers(input: {
  app: any;
  pendingRichForms: Map<string, RichInteractionRequest>;
}): void {
  const { app, pendingRichForms } = input;
  app.action('gantry_rich_form_open', async (args: any) => {
    await args.ack();
    const action = args.action as { value?: string };
    const body = args.body as {
      channel?: { id?: string };
      message?: { ts?: string; thread_ts?: string };
      trigger_id?: string;
    };
    if (!body.trigger_id) return;
    const request = pendingRichForms.get(action.value || '');
    if (!request) return;
    const payload = request.descriptor.rich?.payload ?? {};
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    await app.client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'gantry_rich_form_modal',
        private_metadata: JSON.stringify({
          channelId: body.channel?.id || '',
          interactionId: request.descriptor.id,
          threadTs: body.message?.thread_ts || body.message?.ts || '',
        }),
        title: {
          type: 'plain_text',
          text: (
            request.descriptor.title || RICH_INTERACTION_OPEN_FORM_LABEL
          ).slice(0, 24),
        },
        submit: { type: 'plain_text', text: RICH_INTERACTION_SUBMIT_LABEL },
        close: { type: 'plain_text', text: RICH_INTERACTION_CANCEL_LABEL },
        blocks: fields.length
          ? fields.slice(0, 10).map((field, index) => {
              const item =
                typeof field === 'object' && field !== null
                  ? (field as Record<string, unknown>)
                  : {};
              return {
                type: 'input',
                block_id: `gantry_rich_form_${index}`,
                optional: item.required !== true,
                label: {
                  type: 'plain_text',
                  text: String(
                    item.label || item.id || `Field ${index + 1}`,
                  ).slice(0, 150),
                },
                element: {
                  type: 'plain_text_input',
                  action_id: 'value',
                  multiline: item.type === 'textarea',
                },
              };
            })
          : [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: RICH_INTERACTION_REQUIRED_FIELDS_COPY,
                },
              },
            ],
      },
    });
  });
  app.view('gantry_rich_form_modal', async (args: any) => {
    await args.ack();
    const body = args.body as {
      user?: { id?: string; name?: string; username?: string };
    };
    const view = args.view as { private_metadata?: string };
    let meta: { channelId?: string; interactionId?: string; threadTs?: string };
    try {
      meta = JSON.parse(view.private_metadata || '{}');
    } catch {
      return;
    }
    if (!meta.channelId) return;
    if (meta.interactionId) pendingRichForms.delete(meta.interactionId);
    const displayName =
      body.user?.name || body.user?.username || body.user?.id || 'unknown';
    await app.client.chat.postMessage({
      channel: meta.channelId,
      text: `${RICH_INTERACTION_SUBMITTED_BY_COPY} ${displayName}.`,
      ...(meta.threadTs ? { thread_ts: meta.threadTs } : {}),
    });
  });
}
