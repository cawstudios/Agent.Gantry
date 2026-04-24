import { ONECLI_ALLOWED_ENV_KEYS } from '../../config/index.js';

const ONECLI_ALLOWED_ENV_KEY_SET = new Set<string>(ONECLI_ALLOWED_ENV_KEYS);

export const ONECLI_FORBIDDEN_SECRET_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'MYCLAW_WEBHOOK_SECRET',
]);

export interface OnecliEnvFilterResult {
  env: Record<string, string>;
  droppedKeys: string[];
}

export function filterTrustedOnecliEnv(
  source: Record<string, unknown> | undefined,
): OnecliEnvFilterResult {
  const env: Record<string, string> = {};
  const droppedKeys: string[] = [];
  for (const [key, value] of Object.entries(source || {})) {
    if (ONECLI_FORBIDDEN_SECRET_ENV_KEYS.has(key)) {
      throw new Error(
        `OneCLI returned forbidden raw credential env key: ${key}`,
      );
    }
    if (
      !ONECLI_ALLOWED_ENV_KEY_SET.has(key) ||
      typeof value !== 'string' ||
      value.length === 0
    ) {
      droppedKeys.push(key);
      continue;
    }
    env[key] = value;
  }
  return { env, droppedKeys };
}