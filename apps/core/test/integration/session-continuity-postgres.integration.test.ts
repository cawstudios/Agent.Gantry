import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeSessionScopeKey } from '@core/domain/repositories/ops-repo.js';
import type { ProviderSessionId } from '@core/domain/sessions/sessions.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('Postgres session continuity', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'session_continuity',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('switches between db replay and provider-native resume based on latest artifact metadata', async () => {
    const groupFolder = 'group-session-mode';
    const chatJid = 'tg:group-session-mode';
    const sessionId = 'provider-session:test:mode';

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
    });

    const withoutArtifact = await runtime.sessionOps.getSessionResume({
      groupFolder,
      chatJid,
      threadId: null,
    });
    expect(withoutArtifact.mode).toBe('db_replay');
    expect(withoutArtifact.providerSessionId).toBeUndefined();
    expect(withoutArtifact.externalSessionId).toBeUndefined();
    expect(withoutArtifact.latestArtifactId).toBeUndefined();

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
      latestArtifactId: 'provider-session-artifact:test:mode',
    });

    const withArtifact = await runtime.sessionOps.getSessionResume({
      groupFolder,
      chatJid,
      threadId: null,
    });
    expect(withArtifact.mode).toBe('provider_native');
    expect(withArtifact.providerSessionId).toBe(sessionId);
    expect(withArtifact.externalSessionId).toBe(sessionId);
    expect(withArtifact.latestArtifactId).toBe(
      'provider-session-artifact:test:mode',
    );
    expect(withArtifact.agentSessionId).toBe(withoutArtifact.agentSessionId);
  });

  it('replaces provider session per scope without clobbering a thread scope', async () => {
    const groupFolder = 'group-session-replacement';
    const chatJid = 'tg:group-session-replacement';
    const threadId = 'thread-1';

    await runtime.sessionOps.setSession(
      groupFolder,
      'provider-session:test:root:v1',
      null,
      {
        chatJid,
        latestArtifactId: 'provider-session-artifact:test:root:v1',
      },
    );
    await runtime.sessionOps.setSession(
      groupFolder,
      'provider-session:test:thread:v1',
      threadId,
      {
        chatJid,
        latestArtifactId: 'provider-session-artifact:test:thread:v1',
      },
    );
    await runtime.sessionOps.setSession(
      groupFolder,
      'provider-session:test:root:v2',
      null,
      {
        chatJid,
        latestArtifactId: 'provider-session-artifact:test:root:v2',
      },
    );

    const rootResume = await runtime.sessionOps.getSessionResume({
      groupFolder,
      chatJid,
      threadId: null,
    });
    const threadResume = await runtime.sessionOps.getSessionResume({
      groupFolder,
      chatJid,
      threadId,
    });

    expect(rootResume.mode).toBe('provider_native');
    expect(rootResume.externalSessionId).toBe('provider-session:test:root:v2');
    expect(rootResume.latestArtifactId).toBe(
      'provider-session-artifact:test:root:v2',
    );
    expect(threadResume.mode).toBe('provider_native');
    expect(threadResume.externalSessionId).toBe(
      'provider-session:test:thread:v1',
    );
    expect(threadResume.latestArtifactId).toBe(
      'provider-session-artifact:test:thread:v1',
    );
    expect(rootResume.agentSessionId).not.toBe(threadResume.agentSessionId);

    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        'provider-session:test:root:v1' as ProviderSessionId,
      ),
    ).resolves.toBeNull();
    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        'provider-session:test:root:v2' as ProviderSessionId,
      ),
    ).resolves.toMatchObject({ status: 'active' });
    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        'provider-session:test:thread:v1' as ProviderSessionId,
      ),
    ).resolves.toMatchObject({ status: 'active' });
  });

  it('rejects provider session ids already owned by another agent session', async () => {
    await runtime.sessionOps.setSession(
      'group-session-owner-a',
      'provider-session:test:owned',
      null,
      {
        chatJid: 'tg:group-session-owner-a',
        latestArtifactId: 'provider-session-artifact:test:owned:a',
      },
    );

    await expect(
      runtime.sessionOps.setSession(
        'group-session-owner-b',
        'provider-session:test:owned',
        null,
        {
          chatJid: 'tg:group-session-owner-b',
          latestArtifactId: 'provider-session-artifact:test:owned:b',
        },
      ),
    ).rejects.toThrow(/already owned by another session/);
  });

  it('rejects unsafe provider session ids before persisting resume state', async () => {
    await expect(
      runtime.sessionOps.setSession('group-session-unsafe', '../escape', null, {
        chatJid: 'tg:group-session-unsafe',
        latestArtifactId: 'provider-session-artifact:test:unsafe',
      }),
    ).rejects.toThrow(/Invalid provider session id/);
  });

  it('falls back to db replay after expiring the scoped provider session', async () => {
    const groupFolder = 'group-session-expiry';
    const chatJid = 'tg:group-session-expiry';
    const sessionId = 'provider-session:test:expire';
    const latestArtifactId = 'provider-session-artifact:test:expire';

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
      latestArtifactId,
    });

    const scopeKey = makeSessionScopeKey(groupFolder, null);
    const rawResume = await runtime.canonicalSessionRepository.getSessionResume(
      {
        groupFolder,
        chatJid,
        threadId: null,
        scopeKey,
      },
    );
    expect(rawResume.providerSessionId).toBe(sessionId);

    await runtime.sessionOps.expireProviderSession({
      providerSessionId: rawResume.providerSessionId,
      agentSessionId: rawResume.agentSessionId,
      provider: rawResume.provider,
      externalSessionId: rawResume.externalSessionId,
    });

    const resumed = await runtime.sessionOps.getSessionResume({
      groupFolder,
      chatJid,
      threadId: null,
    });
    expect(resumed.mode).toBe('db_replay');
    expect(resumed.providerSessionId).toBeUndefined();
    expect(resumed.externalSessionId).toBeUndefined();
    expect(resumed.latestArtifactId).toBeUndefined();
  });

  it('keeps session state isolated across independent test schemas', async () => {
    const isolated = await createPostgresIntegrationRuntime({
      schemaPrefix: 'session_continuity_isolated',
    });
    try {
      const groupFolder = 'group-session-isolation';
      const chatJid = 'tg:group-session-isolation';
      const sessionId = 'provider-session:test:isolation';

      await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
        chatJid,
        latestArtifactId: 'provider-session-artifact:test:isolation:primary',
      });
      await isolated.sessionOps.setSession(groupFolder, sessionId, null, {
        chatJid,
        latestArtifactId: 'provider-session-artifact:test:isolation:isolated',
      });

      await expect(
        runtime.sessionOps.getSessionResume({
          groupFolder,
          chatJid,
          threadId: null,
        }),
      ).resolves.toMatchObject({
        mode: 'provider_native',
        latestArtifactId: 'provider-session-artifact:test:isolation:primary',
      });
      await expect(
        isolated.sessionOps.getSessionResume({
          groupFolder,
          chatJid,
          threadId: null,
        }),
      ).resolves.toMatchObject({
        mode: 'provider_native',
        latestArtifactId: 'provider-session-artifact:test:isolation:isolated',
      });
    } finally {
      await isolated.cleanup();
    }
  });
});
