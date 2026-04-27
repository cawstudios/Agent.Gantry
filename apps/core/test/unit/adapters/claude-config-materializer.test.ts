import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderArtifactStore } from '@core/domain/ports/provider-artifact-store.js';
import type { ProviderSessionArtifact } from '@core/domain/sessions/provider-session-artifact.js';
import {
  captureClaudeArtifacts,
  materializeClaudeRuntime,
} from '@core/adapters/llm/anthropic-claude-agent/claude-config-materializer.js';
import type { SkillSource } from '@core/adapters/llm/anthropic-claude-agent/claude-skill-materializer.js';

const context = {
  appId: 'default',
  agentId: 'agent:test',
  agentSessionId: 'agent-session:test',
  providerSessionId: 'provider-session:test',
};

function createFakeStore(seed?: {
  artifact?: ProviderSessionArtifact;
  content?: string;
}): ProviderArtifactStore & {
  puts: Array<{
    artifactKind: string;
    provider: string;
    content: string;
    metadata?: Record<string, unknown>;
  }>;
  latestQueries: Array<{ provider?: string }>;
} {
  const puts: Array<{
    artifactKind: string;
    provider: string;
    content: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const latestQueries: Array<{ provider?: string }> = [];
  return {
    puts,
    latestQueries,
    putArtifact: async (input) => {
      const content =
        typeof input.content === 'string'
          ? input.content
          : Buffer.from(input.content).toString('utf-8');
      puts.push({
        artifactKind: input.artifactKind,
        provider: input.provider,
        content,
        metadata: input.metadata,
      });
      return {
        id: `artifact:${puts.length}` as never,
        appId: input.appId,
        agentId: input.agentId,
        agentSessionId: input.agentSessionId,
        providerSessionId: input.providerSessionId,
        provider: input.provider,
        artifactKind: input.artifactKind,
        storageType: input.storageType ?? 'local-filesystem',
        storageRef: `ref:${puts.length}`,
        contentHash: 'sha256:test',
        sizeBytes: content.length,
        createdAt: input.createdAt ?? '2026-04-27T00:00:00.000Z',
        metadata: input.metadata ?? {},
      };
    },
    getArtifact: async () => seed?.content ?? '',
    getLatestArtifact: async (input) => {
      latestQueries.push({ provider: input.provider });
      return seed?.artifact;
    },
    listArtifacts: async () => (seed?.artifact ? [seed.artifact] : []),
    markDeleted: async () => {},
  };
}

function createSkillSource(root: string): SkillSource {
  const enabledDir = path.join(root, 'enabled-skill');
  const disabledDir = path.join(root, 'disabled-skill');
  fs.mkdirSync(enabledDir, { recursive: true });
  fs.mkdirSync(disabledDir, { recursive: true });
  fs.writeFileSync(path.join(enabledDir, 'SKILL.md'), '# Enabled');
  fs.writeFileSync(path.join(disabledDir, 'SKILL.md'), '# Disabled');
  return {
    listSkills: async () => [
      {
        id: 'enabled-skill',
        name: 'enabled-skill',
        sourceDir: enabledDir,
        enabled: true,
      },
      {
        id: 'disabled-skill',
        name: 'disabled-skill',
        sourceDir: disabledDir,
        enabled: false,
      },
    ],
  };
}

describe('Claude config materializer', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-materializer-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates per-run Claude config, settings, skills, and restored provider artifact', async () => {
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
      sizeBytes: 2,
      createdAt: '2026-04-27T00:00:00.000Z',
      metadata: {},
    } satisfies ProviderSessionArtifact;
    const store = createFakeStore({ artifact, content: '{"type":"user"}\n' });

    const materialization = await materializeClaudeRuntime({
      baseTempDir: path.join(tempRoot, 'run'),
      groupDir: path.join(tempRoot, 'agents', 'test'),
      cliEntryPoint: path.join(tempRoot, 'dist', 'cli', 'index.js'),
      packageRoot: tempRoot,
      sessionId: 'claude-session-1',
      settings: { model: 'sonnet' },
      skillSource: createSkillSource(tempRoot),
      providerArtifactStore: store,
      artifactContext: { ...context, provider: 'anthropic' },
    });

    expect(materialization.claudeConfigDir).toContain(tempRoot);
    expect(
      fs.existsSync(
        path.join(materialization.claudeConfigDir, 'settings.json'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(materialization.skillsDir, 'enabled-skill')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(materialization.skillsDir, 'disabled-skill')),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(materialization.projectDir, 'claude-session-1.jsonl'),
        'utf-8',
      ),
    ).toContain('"type":"user"');
    expect(store.latestQueries[0]?.provider).toBe('anthropic');

    materialization.cleanup();
    expect(fs.existsSync(materialization.baseTempDir)).toBe(false);
  });

  it('ignores durable settings.local.json and excludes raw secrets from generated settings', async () => {
    fs.mkdirSync(path.join(tempRoot, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, '.claude', 'settings.local.json'),
      '{"env":{"ANTHROPIC_API_KEY":"secret"}}',
    );

    const materialization = await materializeClaudeRuntime({
      baseTempDir: path.join(tempRoot, 'run'),
      groupDir: path.join(tempRoot, 'agents', 'test'),
      cliEntryPoint: path.join(tempRoot, 'dist', 'cli', 'index.js'),
      packageRoot: tempRoot,
      settings: { model: 'opus' },
      skillSource: createSkillSource(tempRoot),
    });

    const settingsText = fs.readFileSync(
      path.join(materialization.claudeConfigDir, 'settings.json'),
      'utf-8',
    );
    expect(settingsText).toContain('"model": "opus"');
    expect(settingsText).toContain("' memory-hook load");
    expect(settingsText).not.toContain('ANTHROPIC_API_KEY');
    expect(settingsText).not.toContain('secret');
  });

  it('fails before writing settings when provider options contain raw secrets', async () => {
    await expect(
      materializeClaudeRuntime({
        baseTempDir: path.join(tempRoot, 'run'),
        groupDir: path.join(tempRoot, 'agents', 'test'),
        cliEntryPoint: path.join(tempRoot, 'dist', 'cli', 'index.js'),
        packageRoot: tempRoot,
        settings: {
          providerOptions: {
            ANTHROPIC_API_KEY: 'secret',
          },
        },
        skillSource: createSkillSource(tempRoot),
      }),
    ).rejects.toThrow('raw secret');
    expect(
      fs.existsSync(path.join(tempRoot, 'run', 'claude', 'settings.json')),
    ).toBe(false);
  });

  it('captures updated Claude JSONL and session index through the artifact store', async () => {
    const store = createFakeStore();
    const projectDir = path.join(tempRoot, 'projects', 'test');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'claude-session-1.jsonl'), '{}\n');
    fs.writeFileSync(
      path.join(projectDir, 'sessions-index.json'),
      '{"entries":[]}',
    );

    const captured = await captureClaudeArtifacts({
      providerArtifactStore: store,
      artifactContext: { ...context, provider: 'anthropic' },
      providerSessionId: 'provider-session:test',
      sessionId: 'claude-session-1',
      projectDir,
    });

    expect(captured.latestArtifactId).toBe('artifact:1');
    expect(store.puts.map((put) => put.artifactKind)).toEqual([
      'claude-jsonl',
      'claude-session-index',
    ]);
    expect(store.puts.map((put) => put.provider)).toEqual([
      'anthropic',
      'anthropic',
    ]);
    expect(store.puts[0]?.metadata?.externalSessionId).toBe('claude-session-1');
  });
});
