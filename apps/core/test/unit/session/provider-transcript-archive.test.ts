import { describe, expect, it } from 'vitest';

import type { ProviderArtifactStore } from '@core/domain/ports/provider-artifact-store.js';
import type { ProviderSessionArtifact } from '@core/domain/sessions/provider-session-artifact.js';
import { archiveProviderSessionTranscript } from '@core/session/session-transcript-archive.js';

function createTranscriptStore(content: string): ProviderArtifactStore & {
  exports: string[];
  providers: string[];
} {
  const artifact = {
    id: 'artifact:jsonl' as never,
    appId: 'default' as never,
    agentId: 'agent:test' as never,
    agentSessionId: 'agent-session:test' as never,
    providerSessionId: 'provider-session:test' as never,
    provider: 'anthropic',
    artifactKind: 'claude-jsonl',
    storageType: 'local-filesystem',
    storageRef: 'artifact.jsonl',
    contentHash: 'sha256:test',
    sizeBytes: content.length,
    createdAt: '2026-04-27T00:00:00.000Z',
    metadata: {},
  } satisfies ProviderSessionArtifact;
  const exports: string[] = [];
  const providers: string[] = [];
  return {
    exports,
    providers,
    putArtifact: async (input) => {
      const text =
        typeof input.content === 'string'
          ? input.content
          : Buffer.from(input.content).toString('utf-8');
      exports.push(text);
      providers.push(input.provider);
      return {
        ...artifact,
        id: 'artifact:export' as never,
        artifactKind: input.artifactKind,
        contentHash: 'sha256:export',
        sizeBytes: text.length,
        metadata: input.metadata ?? {},
      };
    },
    getArtifact: async () => content,
    getLatestArtifact: async (input) => {
      providers.push(input.provider ?? '');
      return artifact;
    },
    listArtifacts: async () => [artifact],
    markDeleted: async () => {},
  };
}

describe('archiveProviderSessionTranscript', () => {
  it('exports markdown from provider artifact JSONL', async () => {
    const store = createTranscriptStore(
      [
        JSON.stringify({
          type: 'user',
          message: { content: 'hello' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi there' }] },
        }),
      ].join('\n'),
    );

    await expect(
      archiveProviderSessionTranscript({
        providerArtifactStore: store,
        appId: 'default',
        agentId: 'agent:test',
        agentSessionId: 'agent-session:test',
        providerSessionId: 'provider-session:test',
        provider: 'anthropic',
        sessionId: 'claude-session-1',
        assistantName: 'Andy',
        cause: 'new-session',
      }),
    ).resolves.toBe('artifact:export');

    expect(store.exports[0]).toContain('**User**: hello');
    expect(store.exports[0]).toContain('**Andy**: hi there');
    expect(store.providers).toEqual(['anthropic', 'anthropic']);
  });
});
