import { describe, expect, it } from 'vitest';

import { resolveModelSelection } from '@core/shared/model-catalog.js';
import {
  compatibleAliasesForEngine,
  resolveExecutionRoute,
} from '@core/shared/model-execution-route.js';
import type { AgentEngine } from '@core/shared/agent-engine.js';

function entryFor(alias: string) {
  const resolved = resolveModelSelection(alias);
  if (!resolved.ok) throw new Error(`fixture alias ${alias} did not resolve`);
  return resolved.entry;
}

function route(alias: string, agentEngine: AgentEngine) {
  return resolveExecutionRoute({ entry: entryFor(alias), agentEngine });
}

describe('model execution route matrix', () => {
  it('anthropic_sdk + anthropic provider -> anthropic SDK adapter (both credential modes)', () => {
    const result = route('opus', 'anthropic_sdk');
    expect(result).toMatchObject({
      ok: true,
      value: {
        executionProviderId: 'anthropic:claude-agent-sdk',
        supportedCredentialModes: ['api_key', 'claude_code_oauth'],
      },
    });
  });

  it('anthropic_sdk + openrouter route -> anthropic SDK adapter', () => {
    expect(route('kimi', 'anthropic_sdk')).toMatchObject({
      ok: true,
      value: { executionProviderId: 'anthropic:claude-agent-sdk' },
    });
  });

  it('deepagents + anthropic provider -> langchain adapter, api_key only', () => {
    expect(route('opus', 'deepagents')).toMatchObject({
      ok: true,
      value: {
        executionProviderId: 'deepagents:langchain',
        supportedCredentialModes: ['api_key'],
      },
    });
  });

  it('deepagents + openai provider -> langchain adapter', () => {
    expect(route('gpt', 'deepagents')).toMatchObject({
      ok: true,
      value: {
        executionProviderId: 'deepagents:langchain',
        supportedCredentialModes: ['api_key'],
      },
    });
  });

  it('anthropic_sdk + openai provider -> invalid with the OpenAI-endpoint copy', () => {
    const result = route('gpt', 'anthropic_sdk');
    expect(result).toMatchObject({ ok: false, reason: 'incompatible-engine' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(
        'Model gpt uses the OpenAI endpoint, which is not supported by Anthropic SDK. Choose DeepAgents or an Anthropic-compatible model.',
      );
    }
  });

  it('deepagents + openrouter -> invalid with the generic pair copy listing compatible aliases', () => {
    const result = route('kimi', 'deepagents');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(
        'Model kimi cannot run with DeepAgents. Choose one of: opus, opus-4.7, opus-4.6, sonnet, haiku, gpt, gpt-5.4, gpt-mini.',
      );
    }
  });

  it('lists compatible aliases per engine', () => {
    const sdk = compatibleAliasesForEngine('anthropic_sdk');
    expect(sdk).toContain('opus');
    expect(sdk).toContain('kimi');
    expect(sdk).not.toContain('gpt');

    const deep = compatibleAliasesForEngine('deepagents');
    expect(deep).toContain('opus');
    expect(deep).toContain('gpt');
    expect(deep).not.toContain('kimi');
  });
});
