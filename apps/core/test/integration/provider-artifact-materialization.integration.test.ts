import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PostgresProviderArtifactStore } from '@core/adapters/artifacts/postgres/postgres-provider-artifact-store.js';
import {
  captureClaudeArtifacts,
  materializeClaudeRuntime,
} from '@core/adapters/llm/anthropic-claude-agent/claude-config-materializer.js';
import { makeSessionScopeKey } from '@core/domain/repositories/ops-repo.js';
import type { ProviderSessionArtifactId } from '@core/domain/sessions/provider-session-artifact.js';
import type { ProviderSessionId } from '@core/domain/sessions/sessions.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

maybeDescribe('Postgres provider artifact materialization', () => {
  let runtime: PostgresIntegrationRuntime;
  let artifactStore: PostgresProviderArtifactStore;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'provider_artifact_materialization',
    });
    artifactStore = new PostgresProviderArtifactStore(runtime.service.db, {
      artifactRoot: runtime.artifactRoot,
      defaultStorageType: 'local-filesystem',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('captures transcript artifacts in Postgres and restores them for the next runtime materialization', async () => {
    const groupFolder = 'group-artifacts-capture';
    const chatJid = 'tg:group-artifacts-capture';
    const sessionId = 'claude-session-capture-1';

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
    });

    const rawResume = await runtime.canonicalSessionRepository.getSessionResume(
      {
        groupFolder,
        chatJid,
        threadId: null,
        scopeKey: makeSessionScopeKey(groupFolder, null),
      },
    );
    expect(rawResume.providerSessionId).toBe(sessionId);

    const sourceRoot = makeTempRoot('myclaw-provider-capture-');
    const projectDir = path.join(sourceRoot, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const transcript = '{"type":"user","text":"hello"}\n';
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), transcript);
    fs.writeFileSync(
      path.join(projectDir, 'sessions-index.json'),
      '{"sessions":[]}',
    );

    const captured = await captureClaudeArtifacts({
      providerArtifactStore: artifactStore,
      artifactContext: {
        appId: rawResume.appId as never,
        agentId: rawResume.agentId as never,
        agentSessionId: rawResume.agentSessionId as never,
        provider: rawResume.provider,
      },
      providerSessionId: rawResume.providerSessionId,
      sessionId,
      projectDir,
    });
    expect(captured.latestArtifactId).toMatch(/^provider-session-artifact:/);

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
      latestArtifactId: captured.latestArtifactId,
    });

    const providerSession =
      await runtime.repositories.providerSessions.getProviderSession(
        rawResume.providerSessionId as ProviderSessionId,
      );
    expect(providerSession?.latestArtifactId).toBe(captured.latestArtifactId);

    const resume = await runtime.sessionOps.getSessionResume({
      groupFolder,
      chatJid,
      threadId: null,
    });
    expect(resume.mode).toBe('provider_native');
    expect(resume.latestArtifactId).toBe(captured.latestArtifactId);

    const restoreRoot = makeTempRoot('myclaw-provider-restore-');
    const materialization = await materializeClaudeRuntime({
      baseTempDir: path.join(restoreRoot, 'run'),
      groupDir: path.join(restoreRoot, 'agents', groupFolder),
      cliEntryPoint: path.join(restoreRoot, 'dist', 'cli', 'index.js'),
      packageRoot: restoreRoot,
      sessionId,
      skillSource: { listSkills: async () => [] },
      providerArtifactStore: artifactStore,
      artifactContext: {
        appId: resume.appId as never,
        agentId: resume.agentId as never,
        agentSessionId: resume.agentSessionId as never,
        provider: resume.provider,
        providerSessionId: resume.providerSessionId,
        latestArtifactId: resume.latestArtifactId,
      },
    });

    expect(
      fs.readFileSync(
        path.join(materialization.projectDir, `${sessionId}.jsonl`),
        'utf-8',
      ),
    ).toBe(transcript);
    materialization.cleanup();
  });

  it('resolves latest claude-jsonl via agent-session fallback even when newer non-jsonl artifacts exist', async () => {
    const groupFolder = 'group-artifacts-fallback';
    const chatJid = 'tg:group-artifacts-fallback';
    const sessionId = 'claude-session-fallback-1';

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
    });
    const rawResume = await runtime.canonicalSessionRepository.getSessionResume(
      {
        groupFolder,
        chatJid,
        threadId: null,
        scopeKey: makeSessionScopeKey(groupFolder, null),
      },
    );

    const jsonlArtifact = await artifactStore.putArtifact({
      id: 'provider-session-artifact:test:fallback:jsonl' as ProviderSessionArtifactId,
      appId: rawResume.appId as never,
      agentId: rawResume.agentId as never,
      agentSessionId: rawResume.agentSessionId as never,
      providerSessionId: rawResume.providerSessionId as ProviderSessionId,
      provider: rawResume.provider ?? 'anthropic',
      artifactKind: 'claude-jsonl',
      content: '{"type":"assistant","text":"resume me"}\n',
      contentType: 'application/x-jsonlines',
      createdAt: '2026-04-28T00:00:00.000Z',
    });
    await artifactStore.putArtifact({
      id: 'provider-session-artifact:test:fallback:state' as ProviderSessionArtifactId,
      appId: rawResume.appId as never,
      agentId: rawResume.agentId as never,
      agentSessionId: rawResume.agentSessionId as never,
      providerSessionId: rawResume.providerSessionId as ProviderSessionId,
      provider: rawResume.provider ?? 'anthropic',
      artifactKind: 'provider-state',
      content: '{"state":"newer-but-not-transcript"}',
      contentType: 'application/json',
      createdAt: '2026-04-28T00:00:01.000Z',
    });

    const restoreRoot = makeTempRoot('myclaw-provider-fallback-');
    const materialization = await materializeClaudeRuntime({
      baseTempDir: path.join(restoreRoot, 'run'),
      groupDir: path.join(restoreRoot, 'agents', groupFolder),
      cliEntryPoint: path.join(restoreRoot, 'dist', 'cli', 'index.js'),
      packageRoot: restoreRoot,
      sessionId,
      skillSource: { listSkills: async () => [] },
      providerArtifactStore: artifactStore,
      artifactContext: {
        appId: rawResume.appId as never,
        agentId: rawResume.agentId as never,
        agentSessionId: rawResume.agentSessionId as never,
        provider: rawResume.provider,
      },
    });

    expect(
      fs.readFileSync(
        path.join(materialization.projectDir, `${sessionId}.jsonl`),
        'utf-8',
      ),
    ).toBe(await artifactStore.getArtifact(jsonlArtifact));
    materialization.cleanup();
  });

  it('skips deleted latest artifacts and restores the newest non-deleted transcript', async () => {
    const groupFolder = 'group-artifacts-deleted-fallback';
    const chatJid = 'tg:group-artifacts-deleted-fallback';
    const sessionId = 'claude-session-deleted-fallback-1';

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
    });
    const rawResume = await runtime.canonicalSessionRepository.getSessionResume(
      {
        groupFolder,
        chatJid,
        threadId: null,
        scopeKey: makeSessionScopeKey(groupFolder, null),
      },
    );

    await artifactStore.putArtifact({
      id: 'provider-session-artifact:test:deleted-fallback:older' as ProviderSessionArtifactId,
      appId: rawResume.appId as never,
      agentId: rawResume.agentId as never,
      agentSessionId: rawResume.agentSessionId as never,
      providerSessionId: rawResume.providerSessionId as ProviderSessionId,
      provider: rawResume.provider ?? 'anthropic',
      artifactKind: 'claude-jsonl',
      content: '{"type":"assistant","text":"older transcript"}\n',
      contentType: 'application/x-jsonlines',
      createdAt: '2026-04-28T00:00:00.000Z',
    });
    const newest = await artifactStore.putArtifact({
      id: 'provider-session-artifact:test:deleted-fallback:newest' as ProviderSessionArtifactId,
      appId: rawResume.appId as never,
      agentId: rawResume.agentId as never,
      agentSessionId: rawResume.agentSessionId as never,
      providerSessionId: rawResume.providerSessionId as ProviderSessionId,
      provider: rawResume.provider ?? 'anthropic',
      artifactKind: 'claude-jsonl',
      content: '{"type":"assistant","text":"newest transcript"}\n',
      contentType: 'application/x-jsonlines',
      createdAt: '2026-04-28T00:00:01.000Z',
    });
    await artifactStore.markDeleted(newest);

    const restoreRoot = makeTempRoot('myclaw-provider-deleted-fallback-');
    const materialization = await materializeClaudeRuntime({
      baseTempDir: path.join(restoreRoot, 'run'),
      groupDir: path.join(restoreRoot, 'agents', groupFolder),
      cliEntryPoint: path.join(restoreRoot, 'dist', 'cli', 'index.js'),
      packageRoot: restoreRoot,
      sessionId,
      skillSource: { listSkills: async () => [] },
      providerArtifactStore: artifactStore,
      artifactContext: {
        appId: rawResume.appId as never,
        agentId: rawResume.agentId as never,
        agentSessionId: rawResume.agentSessionId as never,
        provider: rawResume.provider,
        providerSessionId: rawResume.providerSessionId,
      },
    });

    expect(
      fs.readFileSync(
        path.join(materialization.projectDir, `${sessionId}.jsonl`),
        'utf-8',
      ),
    ).toBe('{"type":"assistant","text":"older transcript"}\n');
    materialization.cleanup();
  });

  it('fails materialization when the selected transcript artifact is corrupted on disk', async () => {
    const groupFolder = 'group-artifacts-corrupt';
    const chatJid = 'tg:group-artifacts-corrupt';
    const sessionId = 'claude-session-corrupt-1';

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
    });
    const rawResume = await runtime.canonicalSessionRepository.getSessionResume(
      {
        groupFolder,
        chatJid,
        threadId: null,
        scopeKey: makeSessionScopeKey(groupFolder, null),
      },
    );

    const artifact = await artifactStore.putArtifact({
      id: 'provider-session-artifact:test:corrupt:jsonl' as ProviderSessionArtifactId,
      appId: rawResume.appId as never,
      agentId: rawResume.agentId as never,
      agentSessionId: rawResume.agentSessionId as never,
      providerSessionId: rawResume.providerSessionId as ProviderSessionId,
      provider: rawResume.provider ?? 'anthropic',
      artifactKind: 'claude-jsonl',
      content: '{"type":"assistant","text":"valid transcript"}\n',
      contentType: 'application/x-jsonlines',
      createdAt: '2026-04-28T00:00:02.000Z',
    });
    fs.writeFileSync(
      path.join(runtime.artifactRoot, artifact.storageRef),
      'tampered transcript',
    );

    const restoreRoot = makeTempRoot('myclaw-provider-corrupt-');
    await expect(
      materializeClaudeRuntime({
        baseTempDir: path.join(restoreRoot, 'run'),
        groupDir: path.join(restoreRoot, 'agents', groupFolder),
        cliEntryPoint: path.join(restoreRoot, 'dist', 'cli', 'index.js'),
        packageRoot: restoreRoot,
        sessionId,
        skillSource: { listSkills: async () => [] },
        providerArtifactStore: artifactStore,
        artifactContext: {
          appId: rawResume.appId as never,
          agentId: rawResume.agentId as never,
          agentSessionId: rawResume.agentSessionId as never,
          provider: rawResume.provider,
          providerSessionId: rawResume.providerSessionId,
        },
      }),
    ).rejects.toThrow(/corrupt|hash|checksum/i);
  });
});
