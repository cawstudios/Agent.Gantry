import { describe, expect, it } from 'vitest';

import {
  AGENT_ENGINES,
  DEFAULT_AGENT_ENGINE,
  DEEPAGENTS_ENGINE,
  agentEngineLabel,
  isAgentEngine,
  parseAgentEngine,
  resolveAgentEngine,
} from '@core/shared/agent-engine.js';

describe('agent engine vocabulary', () => {
  it('declares the public values and the system default', () => {
    expect(AGENT_ENGINES).toEqual(['anthropic_sdk', 'deepagents']);
    expect(DEFAULT_AGENT_ENGINE).toBe('anthropic_sdk');
    expect(DEEPAGENTS_ENGINE).toBe('deepagents');
  });

  it('maps engines to display labels', () => {
    expect(agentEngineLabel(DEFAULT_AGENT_ENGINE)).toBe('Anthropic SDK');
    expect(agentEngineLabel(DEEPAGENTS_ENGINE)).toBe('DeepAgents');
  });

  it('guards engine values', () => {
    expect(isAgentEngine('anthropic_sdk')).toBe(true);
    expect(isAgentEngine('deepagents')).toBe(true);
    expect(isAgentEngine('langchain')).toBe(false);
    expect(isAgentEngine(2)).toBe(false);
  });

  it('resolves leniently to the system default for unknown values', () => {
    expect(resolveAgentEngine(undefined)).toBe('anthropic_sdk');
    expect(resolveAgentEngine('DeepAgents')).toBe('deepagents');
    expect(resolveAgentEngine('anthropic-sdk')).toBe('anthropic_sdk');
    expect(resolveAgentEngine('mystery')).toBe('anthropic_sdk');
  });

  it('parses strictly, defaulting only on absence', () => {
    expect(parseAgentEngine(undefined, 'defaults.agent_engine')).toBe(
      'anthropic_sdk',
    );
    expect(parseAgentEngine('deepagents', 'agents.main.agent_engine')).toBe(
      'deepagents',
    );
  });

  it('rejects unknown engine values with the locked copy', () => {
    expect(() => parseAgentEngine('claude', 'defaults.agent_engine')).toThrow(
      'defaults.agent_engine: Unsupported agent engine: claude. Choose anthropic_sdk or deepagents.',
    );
    expect(() => parseAgentEngine(7, 'agents.main.agent_engine')).toThrow(
      'agents.main.agent_engine: Unsupported agent engine: 7. Choose anthropic_sdk or deepagents.',
    );
  });
});
