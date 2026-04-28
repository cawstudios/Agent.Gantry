import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PostgresProviderArtifactStore } from '@core/adapters/artifacts/postgres/postgres-provider-artifact-store.js';

function fakeDb(
  options: {
    failTransaction?: boolean;
    providerSession?: {
      appId: string;
      agentSessionId: string;
      provider: string;
    } | null;
  } = {},
) {
  const rows: unknown[] = [];
  const providerSession = options.providerSession ?? {
    appId: 'app:test',
    agentSessionId: 'agent-session:test',
    provider: 'anthropic',
  };
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: async () =>
              providerSession
                ? [{ id: 'provider-session:test', ...providerSession }]
                : [],
          }),
        }),
      }),
    }),
    insert: () => ({
      values: async (row: unknown) => {
        rows.push(row);
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => {},
      }),
    }),
  };
  return {
    rows,
    db: {
      transaction: async (callback: (transaction: typeof tx) => unknown) => {
        if (options.failTransaction) {
          throw new Error('metadata insert failed');
        }
        return callback(tx);
      },
    } as never,
  };
}

describe('PostgresProviderArtifactStore local filesystem backend', () => {
  it('writes artifact bytes and records hash and size metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-artifacts-'));
    const { db, rows } = fakeDb();
    const store = new PostgresProviderArtifactStore(db, {
      artifactRoot: root,
      defaultStorageType: 'local-filesystem',
    });

    const artifact = await store.putArtifact({
      id: 'provider-session-artifact:test' as never,
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      agentSessionId: 'agent-session:test' as never,
      providerSessionId: 'provider-session:test' as never,
      provider: 'anthropic',
      artifactKind: 'claude-jsonl',
      content: '{"type":"user"}\n',
      contentType: 'application/x-jsonlines',
    });

    expect(artifact.storageType).toBe('local-filesystem');
    expect(artifact.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(artifact.sizeBytes).toBe(Buffer.byteLength('{"type":"user"}\n'));
    expect(rows).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, artifact.storageRef), 'utf8')).toBe(
      '{"type":"user"}\n',
    );
    await expect(store.getArtifact(artifact)).resolves.toBe(
      '{"type":"user"}\n',
    );
  });

  it('rejects local artifact refs that escape the artifact root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-artifacts-'));
    const { db } = fakeDb();
    const store = new PostgresProviderArtifactStore(db, {
      artifactRoot: root,
      defaultStorageType: 'local-filesystem',
    });

    await expect(
      store.getArtifact({
        id: 'provider-session-artifact:escape' as never,
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        agentSessionId: 'agent-session:test' as never,
        providerSessionId: 'provider-session:test' as never,
        provider: 'anthropic',
        artifactKind: 'claude-jsonl',
        storageType: 'local-filesystem',
        storageRef: '../escape.jsonl',
        contentHash: 'sha256:unused',
        sizeBytes: 0,
        createdAt: '2026-04-27T00:00:00.000Z',
        metadata: {},
      }),
    ).rejects.toThrow(/escapes artifact root/);
  });

  it('removes local artifact bytes when metadata write fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-artifacts-'));
    const { db } = fakeDb({ failTransaction: true });
    const store = new PostgresProviderArtifactStore(db, {
      artifactRoot: root,
      defaultStorageType: 'local-filesystem',
    });

    await expect(
      store.putArtifact({
        id: 'provider-session-artifact:rollback' as never,
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        agentSessionId: 'agent-session:test' as never,
        providerSessionId: 'provider-session:test' as never,
        provider: 'anthropic',
        artifactKind: 'claude-jsonl',
        content: '{"type":"user"}\n',
      }),
    ).rejects.toThrow('metadata insert failed');

    expect(
      fs
        .readdirSync(root, { recursive: true })
        .filter((entry) => String(entry).endsWith('.jsonl')),
    ).toHaveLength(0);
  });

  it('rejects artifact writes when provider session ownership does not match', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-artifacts-'));
    const { db } = fakeDb({
      providerSession: {
        appId: 'app:other',
        agentSessionId: 'agent-session:other',
        provider: 'anthropic',
      },
    });
    const store = new PostgresProviderArtifactStore(db, {
      artifactRoot: root,
      defaultStorageType: 'local-filesystem',
    });

    await expect(
      store.putArtifact({
        id: 'provider-session-artifact:poisoned' as never,
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        agentSessionId: 'agent-session:test' as never,
        providerSessionId: 'provider-session:test' as never,
        provider: 'anthropic',
        artifactKind: 'claude-jsonl',
        content: '{"type":"user"}\n',
      }),
    ).rejects.toThrow(/does not match provider session/);

    expect(
      fs
        .readdirSync(root, { recursive: true })
        .filter((entry) => String(entry).endsWith('.jsonl')),
    ).toHaveLength(0);
  });

  it('rejects corrupt local artifact bytes by hash metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-artifacts-'));
    const { db } = fakeDb();
    const store = new PostgresProviderArtifactStore(db, {
      artifactRoot: root,
      defaultStorageType: 'local-filesystem',
    });
    const artifact = await store.putArtifact({
      id: 'provider-session-artifact:corrupt' as never,
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      agentSessionId: 'agent-session:test' as never,
      providerSessionId: 'provider-session:test' as never,
      provider: 'anthropic',
      artifactKind: 'claude-jsonl',
      content: '{"type":"user"}\n',
      contentType: 'application/x-jsonlines',
    });

    fs.writeFileSync(path.join(root, artifact.storageRef), 'corrupt\n');

    await expect(store.getArtifact(artifact)).rejects.toThrow(
      /Provider artifact hash mismatch/,
    );
  });

  it('does not return deleted artifact content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-artifacts-'));
    const { db } = fakeDb();
    const store = new PostgresProviderArtifactStore(db, {
      artifactRoot: root,
      defaultStorageType: 'local-filesystem',
    });
    const artifact = await store.putArtifact({
      id: 'provider-session-artifact:deleted' as never,
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      agentSessionId: 'agent-session:test' as never,
      providerSessionId: 'provider-session:test' as never,
      provider: 'anthropic',
      artifactKind: 'claude-jsonl',
      content: '{}\n',
    });

    await expect(
      store.getArtifact({
        ...artifact,
        deletedAt: '2026-04-27T00:00:00.000Z',
      }),
    ).rejects.toThrow('Provider artifact not found');
  });
});
