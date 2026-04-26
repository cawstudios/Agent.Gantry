import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('resolveClaudeAuthState', () => {
  let runtimeRoot = '';

  afterEach(() => {
    if (runtimeRoot) {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      runtimeRoot = '';
    }
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('does not treat model-only external mode as broker auth', async () => {
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'external');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    vi.stubEnv('ONECLI_URL', '');
    vi.resetModules();

    const { resolveClaudeAuthState } = await import('@core/config/index.js');

    expect(resolveClaudeAuthState().mode).toBe('none');
  });

  it('treats external mode as broker auth when a broker endpoint exists', async () => {
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'external');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://broker.local/anthropic');
    vi.stubEnv('ONECLI_URL', '');
    vi.resetModules();

    const { resolveClaudeAuthState } = await import('@core/config/index.js');

    expect(resolveClaudeAuthState().mode).toBe('broker');
  });

  it('uses runtime .env before ambient env for channel credential getters', async () => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-config-'));
    fs.writeFileSync(
      path.join(runtimeRoot, 'settings.yaml'),
      [
        'storage:',
        '  postgres:',
        '    url_env: MYCLAW_DATABASE_URL',
        '    schema: myclaw',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(runtimeRoot, '.env'),
      [
        'TELEGRAM_BOT_TOKEN=file-telegram-token',
        'SLACK_BOT_TOKEN=file-slack-bot-token',
        'SLACK_APP_TOKEN=file-slack-app-token',
        '',
      ].join('\n'),
      'utf-8',
    );
    vi.stubEnv('MYCLAW_HOME', runtimeRoot);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'ambient-telegram-token');
    vi.stubEnv('SLACK_BOT_TOKEN', 'ambient-slack-bot-token');
    vi.stubEnv('SLACK_APP_TOKEN', 'ambient-slack-app-token');
    vi.resetModules();

    const { getTelegramBotToken, getSlackBotToken, getSlackAppToken } =
      await import('@core/config/index.js');

    expect(getTelegramBotToken()).toBe('file-telegram-token');
    expect(getSlackBotToken()).toBe('file-slack-bot-token');
    expect(getSlackAppToken()).toBe('file-slack-app-token');
  });

  it('uses runtime .env before ambient env for default model and storage URL', async () => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-config-'));
    fs.writeFileSync(
      path.join(runtimeRoot, 'settings.yaml'),
      [
        'storage:',
        '  postgres:',
        '    url_env: MYCLAW_DATABASE_URL',
        '    schema: myclaw',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(runtimeRoot, '.env'),
      [
        'ANTHROPIC_MODEL=claude-file-model',
        'MYCLAW_DATABASE_URL=postgres://file:pass@localhost:15432/myclaw',
        '',
      ].join('\n'),
      'utf-8',
    );
    vi.stubEnv('MYCLAW_HOME', runtimeRoot);
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-ambient-model');
    vi.stubEnv(
      'MYCLAW_DATABASE_URL',
      'postgres://ambient:pass@localhost:15432/myclaw',
    );
    vi.resetModules();

    const { ANTHROPIC_MODEL, STORAGE_POSTGRES_URL } =
      await import('@core/config/index.js');

    expect(ANTHROPIC_MODEL).toBe('claude-file-model');
    expect(STORAGE_POSTGRES_URL).toBe(
      'postgres://file:pass@localhost:15432/myclaw',
    );
  });
});
