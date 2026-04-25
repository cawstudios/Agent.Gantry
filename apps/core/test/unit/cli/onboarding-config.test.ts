import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { persistOnboardingConfig } from '@core/cli/onboarding-config.js';
import { readEnvFile } from '@core/config/env/file.js';
import {
  envFilePath,
  settingsFilePath,
} from '@core/config/settings/runtime-home.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-onboarding-config-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

function baseInput(runtimeHome: string) {
  return {
    runtimeHome,
    postgresDatabaseUrl: 'postgresql://myclaw_app:pass@localhost:15432/myclaw',
    onecliPostgresDatabaseUrl:
      'postgresql://onecli_app:pass@localhost:15432/myclaw?schema=onecli',
    postgresSchema: 'myclaw',
    onecliPostgresSchema: 'onecli',
    primaryProvider: 'telegram' as const,
    telegramBotToken: 'telegram-token',
    telegramPermissionApproverIds: '123',
    credentialMode: 'onecli' as const,
    onecliUrl: 'http://localhost:10254',
    anthropicModel: 'sonnet',
    memoryEnabled: true,
    embeddingsEnabled: false,
    dreamingEnabled: true,
  };
}

afterEach(() => {
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('onboarding config persistence', () => {
  it('clears raw provider credentials while writing brokered runtime config', () => {
    const runtimeHome = makeRuntimeHome();
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(
      envFilePath(runtimeHome),
      [
        'OPENAI_API_KEY=sk-old',
        'ANTHROPIC_API_KEY=sk-ant-old',
        'ANTHROPIC_AUTH_TOKEN=ant-token',
        'CLAUDE_CODE_OAUTH_TOKEN=oauth-old',
        'SECRET_ENCRYPTION_KEY=123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
        '',
      ].join('\n'),
    );

    persistOnboardingConfig(baseInput(runtimeHome));

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.MYCLAW_DATABASE_URL).toContain('myclaw_app');
    expect(env.ONECLI_DATABASE_URL).toContain('onecli_app');
    expect(env.SECRET_ENCRYPTION_KEY).toBe(
      '123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
    );
    expect(env.ONECLI_URL).toBe('http://localhost:10254');
  });

  it('generates a stable OneCLI encryption key when none exists', () => {
    const runtimeHome = makeRuntimeHome();

    persistOnboardingConfig(baseInput(runtimeHome));

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.SECRET_ENCRYPTION_KEY).toHaveLength(44);
    expect(fs.existsSync(settingsFilePath(runtimeHome))).toBe(true);
  });

  it('requires OneCLI database URL when MyClaw database URL is configured', () => {
    const runtimeHome = makeRuntimeHome();

    expect(() =>
      persistOnboardingConfig({
        ...baseInput(runtimeHome),
        onecliPostgresDatabaseUrl: '',
      }),
    ).toThrow(/ONECLI_DATABASE_URL is required/);

    expect(
      readEnvFile(envFilePath(runtimeHome)).MYCLAW_DATABASE_URL,
    ).toBeUndefined();
  });

  it('rejects OneCLI database URLs that do not share the MyClaw database', () => {
    const runtimeHome = makeRuntimeHome();

    expect(() =>
      persistOnboardingConfig({
        ...baseInput(runtimeHome),
        onecliPostgresDatabaseUrl:
          'postgresql://onecli_app:pass@localhost:15432/other?schema=onecli',
      }),
    ).toThrow(/same Postgres database/);

    expect(
      readEnvFile(envFilePath(runtimeHome)).MYCLAW_DATABASE_URL,
    ).toBeUndefined();
  });
});
