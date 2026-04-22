import * as p from '@clack/prompts';

import { getServiceStatus } from './service-manager.js';

export interface SetupReadyDraft {
  runtimeHome: string;
  storageProvider: 'sqlite' | 'postgres';
  primaryProvider: 'telegram' | 'slack';
  telegramChatJid: string;
  slackChatJid: string;
  selectedModel: string;
  credentialMode: 'env-only' | 'onecli-only' | 'hybrid';
  onecliUrl: string;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
}

export type ReadyStepAction =
  | { type: 'next' }
  | { type: 'start_now' }
  | { type: 'back' }
  | { type: 'resume' }
  | { type: 'cancel' };

function summarizeToggle(value: boolean): string {
  return value ? 'on' : 'off';
}

export async function runReadyStep(
  draft: SetupReadyDraft,
): Promise<ReadyStepAction> {
  const service = getServiceStatus(draft.runtimeHome);
  const providerLabel =
    draft.primaryProvider === 'slack' ? 'Slack conversation' : 'Telegram chat';
  const providerChatJid =
    draft.primaryProvider === 'slack'
      ? draft.slackChatJid || '(pending)'
      : draft.telegramChatJid || '(pending)';
  p.note(
    [
      `Runtime home: ${draft.runtimeHome}`,
      `Storage: ${draft.storageProvider}`,
      `Primary provider: ${draft.primaryProvider}`,
      `${providerLabel}: ${providerChatJid}`,
      `Main model: ${draft.selectedModel}`,
      `Credential mode: ${draft.credentialMode}`,
      ...(draft.onecliUrl ? [`OneCLI URL: ${draft.onecliUrl}`] : []),
      `Memory: ${summarizeToggle(draft.memoryEnabled)}`,
      `Memory root: memory/`,
      `Embeddings: ${draft.embeddingsEnabled ? 'openai' : 'disabled'}`,
      `Dreaming: ${summarizeToggle(draft.dreamingEnabled)}`,
      `Service (${service.kind}): ${service.status}`,
    ].join('\n'),
    'Ready',
  );

  const value = await p.select({
    message: 'Setup complete. What should MyClaw do now?',
    options: [
      {
        value: 'next',
        label: 'Finish setup and exit (Recommended)',
        hint: 'Return to the terminal. Start later with `myclaw start`.',
      },
      {
        value: 'start_now',
        label: 'Start MyClaw now',
        hint: `Begin listening on ${draft.primaryProvider} immediately.`,
      },
      {
        value: 'back',
        label: 'Back',
      },
      {
        value: 'resume',
        label: 'Resume Later',
      },
      {
        value: 'cancel',
        label: 'Cancel Setup',
      },
    ],
  });

  if (p.isCancel(value) || value === 'resume') return { type: 'resume' };
  if (value === 'back') return { type: 'back' };
  if (value === 'cancel') return { type: 'cancel' };
  if (value === 'start_now') return { type: 'start_now' };
  return { type: 'next' };
}