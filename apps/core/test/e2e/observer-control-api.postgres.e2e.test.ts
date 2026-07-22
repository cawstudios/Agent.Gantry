import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresCanonicalGraphRepository } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import { resolveObserverOwnerRoute } from '@core/config/settings/observer-activation.js';
import {
  isObserverSubjectKey,
  type ObserverSubjectKey,
} from '@core/domain/ports/observer-insights.js';
import {
  memoryAgentIdForWorkspaceFolder,
  subjectIdFor,
} from '@core/memory/app-memory-boundaries.js';
import { resolveScopedMemorySubject } from '@core/memory/app-memory-subject-resolver.js';

import {
  createDefaultRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { createClient } from '../../../../packages/sdk/src/index.js';

import type { PostgresIntegrationRuntime } from '../harness/postgres-integration-runtime.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;
const TOKEN = 'observer-e2e-token';

maybeDescribe('observer Control API SDK round trip (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let server: { baseUrl: string; close(): Promise<void> };
  let runtimeHome: string;
  let previousRuntimeHome: string | undefined;
  let observedSubject: ObserverSubjectKey;
  const settings = createDefaultRuntimeSettings();

  beforeAll(async () => {
    previousRuntimeHome = process.env.GANTRY_HOME;
    runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-observer-control-e2e-'),
    );
    process.env.GANTRY_HOME = runtimeHome;
    const { createPostgresIntegrationRuntime } =
      await import('../harness/postgres-integration-runtime.js');
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'observer_control_e2e',
    });
    settings.providers.telegram = { enabled: true };
    settings.observer = {
      enabled: false,
      owner: { recipient: 'owner-1', conversation: 'owner_dm' },
    };
    settings.memory.enabled = true;
    settings.memory.dreaming.enabled = true;
    settings.agents.main_agent = {
      name: 'Main Agent',
      folder: 'main_agent',
      model: 'opus',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
    };
    settings.providerAccounts.telegram_default = {
      agentId: 'main_agent',
      provider: 'telegram',
      label: 'Telegram',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.conversations.owner_dm = {
      providerAccount: 'telegram_default',
      externalId: 'tg:owner-1',
      kind: 'dm',
      displayName: 'Owner DM',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['owner-1'],
    };

    const owner = resolveObserverOwnerRoute(settings);
    if (!owner.ok) throw new Error(`Observer owner failed: ${owner.reason}`);
    const { subject } = resolveScopedMemorySubject({
      appId: 'default',
      agentId: memoryAgentIdForWorkspaceFolder('main_agent'),
      conversationId: 'tg:observed-channel',
      scope: 'group',
    });
    if (subject.subjectType !== 'channel') {
      throw new Error('Observed insight subject was not conversation-scoped');
    }
    const subjectKey = subjectIdFor(subject);
    if (!isObserverSubjectKey(subjectKey)) {
      throw new Error('Observed conversation subject was not canonical');
    }
    observedSubject = subjectKey;
    saveRuntimeSettings(runtimeHome, settings);
    const [{ _setRuntimeStorageForTest }, { startTestControlServer }] =
      await Promise.all([
        import('@core/adapters/storage/postgres/runtime-store.js'),
        import('../harness/control-http-server.js'),
      ]);
    _setRuntimeStorageForTest(runtime.storageRuntime);
    const now = '2026-07-21T00:00:00.000Z';
    const conversationId = 'conversation:telegram_default:tg:owner-1' as never;
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: 'telegram_default' as never,
      appId: 'default' as never,
      agentId: 'agent:main_agent' as never,
      providerId: 'telegram' as never,
      label: 'Telegram',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveConversation({
      id: conversationId,
      appId: 'default' as never,
      providerAccountId: 'telegram_default' as never,
      externalRef: { kind: 'conversation', value: 'owner-1' },
      kind: 'direct',
      title: 'Owner DM',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const graph = new PostgresCanonicalGraphRepository(runtime.service.db);
    await graph.ensureParticipant({
      conversationId,
      providerId: 'telegram',
      providerAccountId: 'telegram_default',
      externalUserId: 'owner-1',
      timestamp: now,
    });
    await runtime.repositories.conversations.replaceConversationApprovers({
      appId: 'default' as never,
      conversationId,
      externalUserIds: ['owner-1'],
      updatedAt: now,
    });
    server = await startTestControlServer({
      token: TOKEN,
      appId: 'default',
      scopes: ['memory:read'],
    });

    await runtime.repositories.observerInsights.create({
      id: 'insight-e2e-1',
      appId: 'default',
      subject: observedSubject,
      insightType: 'commitment',
      title: 'Ship the follow-up',
      summary: 'The owner committed to a follow-up.',
      evidenceRefs: [{ permalink: 'https://example.test/messages/1' }],
      batchSnapshotAt: '2026-07-21T00:00:00.000Z',
      evidenceVersion: 1,
      canonicalSignature: 'commitment:ship-follow-up',
      confidence: 0.95,
      priorityScore: 0.9,
      recipient: 'owner-1',
      nowIso: '2026-07-21T01:00:00.000Z',
    });
  }, 60_000);

  afterAll(async () => {
    if (server) await server.close();
    if (runtime) await runtime.cleanup();
    if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
    if (previousRuntimeHome === undefined) delete process.env.GANTRY_HOME;
    else process.env.GANTRY_HOME = previousRuntimeHome;
  });

  it('reflects disabled/enabled runtime activation and lists persisted insights through the SDK', async () => {
    let client = createClient({ apiKey: TOKEN, baseUrl: server.baseUrl });

    await expect(client.observer.status()).resolves.toMatchObject({
      enabled: false,
      activation: 'disabled',
      counts: { insights: 1, pendingInsights: 1 },
    });

    settings.observer.enabled = true;
    saveRuntimeSettings(runtimeHome, settings);
    await expect(client.observer.status()).resolves.toMatchObject({
      enabled: false,
      activation: 'disabled',
    });

    await server.close();
    const { startTestControlServer } =
      await import('../harness/control-http-server.js');
    server = await startTestControlServer({
      token: TOKEN,
      appId: 'default',
      scopes: ['memory:read'],
    });
    client = createClient({ apiKey: TOKEN, baseUrl: server.baseUrl });
    await expect(client.observer.status()).resolves.toMatchObject({
      enabled: true,
      activation: 'evidence_accumulating',
      dreamingEnabled: false,
      message:
        'Dreaming is off; evidence is accumulating, but promotion is disabled.',
      owner: {
        recipient: 'owner-1',
        conversation: 'owner_dm',
        conversationJid: 'tg:owner-1',
      },
    });

    await expect(
      client.observer.insights({ subject: observedSubject, state: 'pending' }),
    ).resolves.toMatchObject({
      insights: [
        {
          id: 'insight-e2e-1',
          canonicalSignature: 'commitment:ship-follow-up',
          state: 'pending',
        },
      ],
      nextCursor: null,
    });
  });
});
