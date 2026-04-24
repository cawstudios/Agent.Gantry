import fs from 'fs';

import { resolveHostCredentialMode } from '../config/credentials/mode.js';
import type { HostCredentialMode } from '../config/credentials/mode.js';
import { readEnvFile } from '../config/env/file.js';
import {
  envFilePath,
  settingsFilePath,
} from '../config/settings/runtime-home.js';
import {
  createDefaultRuntimeSettings,
  loadRuntimeSettingsFromPath,
} from '../config/settings/runtime-settings.js';
import {
  DEFAULT_SETUP_MODEL,
  normalizeClaudeModelSelection,
} from '../models/claude-model-registry.js';
import { writeOnboardingState } from './onboarding-state.js';
import type { OnboardingState, OnboardingStep } from './onboarding-state.js';

export const FULL_SEQUENCE: OnboardingStep[] = [
  'welcome',
  'runtime_home',
  'storage',
  'prerequisites',
  'channel',
  'telegram',
  'slack',
  'credentials',
  'model',
  'memory',
  'embeddings',
  'dreaming',
  'service',
  'config',
  'group',
  'verify',
  'ready',
];

export type ServiceChoice = 'skip' | 'install' | 'install_start';

export interface SetupDraft {
  runtimeHome: string;
  postgresDatabaseUrl: string;
  postgresSchema: string;
  primaryProvider: 'telegram' | 'slack';
  credentialMode: HostCredentialMode;
  onecliUrl: string;
  selectedModel: string;
  telegramBotToken: string;
  telegramChatJid: string;
  telegramDisplayName: string;
  telegramAdminSenderId: string;
  telegramAdminSenderName: string;
  telegramPermissionApproverIds: string;
  telegramBotUsername: string;
  slackBotToken: string;
  slackAppToken: string;
  slackChatJid: string;
  slackDisplayName: string;
  slackPermissionApproverIds: string;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
  openAiApiKey: string;
  serviceChoice: ServiceChoice;
  serviceStartedAfterSetup: boolean;
  startAfterSetup: boolean;
}

export interface SetupFlowOptions {
  importMetaUrl: string;
  runtimeHome: string;
  initialStep?: OnboardingStep;
  title?: string;
}

export interface SetupFlowResult {
  status: 'completed' | 'resumed' | 'cancelled';
  runtimeHome: string;
  startAfterSetup: boolean;
}

export function defaultStepIndex(step: OnboardingStep | undefined): number {
  if (!step) return 0;
  const idx = FULL_SEQUENCE.indexOf(step);
  return idx >= 0 ? idx : 0;
}

export function shouldSkipStep(
  step: OnboardingStep,
  draft: SetupDraft,
): boolean {
  if (step === 'telegram' && draft.primaryProvider !== 'telegram') return true;
  if (step === 'slack' && draft.primaryProvider !== 'slack') return true;
  return false;
}

export function updateStateData(
  state: OnboardingState,
  draft: SetupDraft,
): void {
  state.data = {
    runtimeHome: draft.runtimeHome,
    primaryProvider: draft.primaryProvider,
    serviceChoice: draft.serviceChoice,
    telegramBotUsername: draft.telegramBotUsername || undefined,
    telegramChatJid: draft.telegramChatJid || undefined,
    telegramAdminSenderId: draft.telegramAdminSenderId || undefined,
    telegramAdminSenderName: draft.telegramAdminSenderName || undefined,
    telegramPermissionApproverIds:
      draft.telegramPermissionApproverIds || undefined,
    slackChatJid: draft.slackChatJid || undefined,
    slackPermissionApproverIds: draft.slackPermissionApproverIds || undefined,
    credentialMode: draft.credentialMode,
    onecliUrl: draft.onecliUrl || undefined,
    selectedModel: draft.selectedModel || undefined,
    memoryEnabled: draft.memoryEnabled,
    embeddingsEnabled: draft.embeddingsEnabled,
    dreamingEnabled: draft.dreamingEnabled,
  };
}

export function persistProgress(
  state: OnboardingState,
  runtimeHome: string,
): void {
  writeOnboardingState(runtimeHome, state);
}

function loadExistingRuntimeSettings(runtimeHome: string) {
  const filePath = settingsFilePath(runtimeHome);
  if (!fs.existsSync(filePath)) {
    return createDefaultRuntimeSettings();
  }
  try {
    return loadRuntimeSettingsFromPath(filePath);
  } catch {
    return createDefaultRuntimeSettings();
  }
}

export function restoreDraft(
  runtimeHome: string,
  state: OnboardingState | null,
): SetupDraft {
  const env = readEnvFile(envFilePath(runtimeHome));
  const settings = loadExistingRuntimeSettings(runtimeHome);
  const savedTelegramChatJid = state?.data.telegramChatJid || '';
  const savedSlackChatJid = state?.data.slackChatJid || '';
  const savedOnecliUrl = state?.data.onecliUrl || env.ONECLI_URL?.trim() || '';
  const primaryProvider =
    state?.data.primaryProvider ||
    (settings.channels.slack?.enabled ? 'slack' : 'telegram');
  const credentialMode = resolveHostCredentialMode(
    state?.data.credentialMode || env.MYCLAW_CREDENTIAL_MODE,
  );
  const hasConfiguredChannel = Object.values(settings.channels).some(
    (channel) => channel.enabled,
  );
  const defaultDreamingEnabled = hasConfiguredChannel
    ? settings.memory.dreaming.enabled
    : true;
  const postgresUrlEnv =
    settings.storage.postgres.urlEnv || 'MYCLAW_DATABASE_URL';
  const postgresDatabaseUrl =
    env[postgresUrlEnv]?.trim() || process.env[postgresUrlEnv]?.trim() || '';
  return {
    runtimeHome,
    postgresDatabaseUrl,
    postgresSchema: settings.storage.postgres.schema || 'myclaw',
    primaryProvider,
    credentialMode,
    onecliUrl: savedOnecliUrl,
    selectedModel:
      normalizeClaudeModelSelection(
        state?.data.selectedModel || env.ANTHROPIC_MODEL,
      ) || DEFAULT_SETUP_MODEL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatJid: savedTelegramChatJid,
    telegramDisplayName: 'Telegram Main',
    telegramAdminSenderId: state?.data.telegramAdminSenderId || '',
    telegramAdminSenderName: state?.data.telegramAdminSenderName || '',
    telegramPermissionApproverIds:
      state?.data.telegramPermissionApproverIds ||
      env.TELEGRAM_PERMISSION_APPROVER_IDS ||
      '',
    telegramBotUsername: state?.data.telegramBotUsername || '',
    slackBotToken: env.SLACK_BOT_TOKEN || '',
    slackAppToken: env.SLACK_APP_TOKEN || '',
    slackChatJid: savedSlackChatJid,
    slackDisplayName: 'Slack Main',
    slackPermissionApproverIds:
      state?.data.slackPermissionApproverIds ||
      env.SLACK_PERMISSION_APPROVER_IDS ||
      '',
    memoryEnabled: state?.data.memoryEnabled ?? settings.memory.enabled,
    embeddingsEnabled:
      state?.data.embeddingsEnabled ?? settings.memory.embeddings.enabled,
    dreamingEnabled: state?.data.dreamingEnabled ?? defaultDreamingEnabled,
    openAiApiKey: env.OPENAI_API_KEY || '',
    serviceChoice: state?.data.serviceChoice || 'skip',
    serviceStartedAfterSetup: false,
    startAfterSetup: false,
  };
}