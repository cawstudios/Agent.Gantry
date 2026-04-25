import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { restoreDraft, updateStateData } from '@core/cli/setup-flow.js';
import { readOnboardingState } from '@core/cli/onboarding-state.js';
import { onboardingStatePath } from '@core/config/settings/runtime-home.js';

const tempRoots: string[] = [];

function makeRuntimeHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-setup-flow-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('setup-flow draft restore', () => {
  it('does not create settings.yaml before setup confirmation', () => {
    const runtimeHome = makeRuntimeHome();
    const settingsPath = path.join(runtimeHome, 'settings.yaml');

    const draft = restoreDraft(runtimeHome, null);

    expect(draft.runtimeHome).toBe(runtimeHome);
    expect(draft.postgresSetupKind).toBe('existing');
    expect(draft.postgresSchema).toBe('myclaw');
    expect(draft.onecliPostgresSchema).toBe('onecli');
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('does not persist credential-bearing Postgres URLs in onboarding state', () => {
    const runtimeHome = makeRuntimeHome();
    const draft = restoreDraft(runtimeHome, null);
    draft.postgresSetupKind = 'hosted';
    draft.postgresDatabaseUrl =
      'postgres://myclaw:pass@db.example.com:5432/myclaw?sslmode=require';
    draft.onecliPostgresDatabaseUrl =
      'postgres://onecli:pass@db.example.com:5432/myclaw?sslmode=require&schema=agent_vault';
    draft.postgresSchema = 'hosted_myclaw';
    draft.onecliPostgresSchema = 'agent_vault';
    draft.primaryProvider = 'slack';
    draft.slackChatJid = 'sl:C123';

    const state = {
      version: 1 as const,
      status: 'in_progress' as const,
      currentStep: 'storage' as const,
      updatedAt: new Date().toISOString(),
      data: {},
    };
    updateStateData(state, draft);
    fs.mkdirSync(path.dirname(onboardingStatePath(runtimeHome)), {
      recursive: true,
    });
    fs.writeFileSync(
      onboardingStatePath(runtimeHome),
      `${JSON.stringify(state, null, 2)}\n`,
    );

    const restoredState = readOnboardingState(runtimeHome);
    const restored = restoreDraft(runtimeHome, restoredState);
    const restoredData = restoredState?.data as Record<string, unknown>;

    expect(restored.postgresSetupKind).toBe('hosted');
    expect(restoredData.postgresDatabaseUrl).toBeUndefined();
    expect(restoredData.onecliPostgresDatabaseUrl).toBeUndefined();
    expect(restored.postgresDatabaseUrl).toBe('');
    expect(restored.onecliPostgresDatabaseUrl).toBe('');
    expect(restored.postgresSchema).toBe('hosted_myclaw');
    expect(restored.onecliPostgresSchema).toBe('agent_vault');
    expect(restored.primaryProvider).toBe('slack');
    expect(restored.slackChatJid).toBe('sl:C123');
  });
});
