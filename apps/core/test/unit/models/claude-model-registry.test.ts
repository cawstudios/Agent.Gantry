import { describe, expect, it } from 'vitest';

import {
  CLAUDE_MODEL_PINS,
  normalizeClaudeModelSelection,
} from '@core/models/claude-model-registry.js';

describe('normalizeClaudeModelSelection', () => {
  it('keeps supported Claude Code aliases as aliases', () => {
    expect(normalizeClaudeModelSelection('opus')).toBe('opus');
    expect(normalizeClaudeModelSelection(' sonnet ')).toBe('sonnet');
    expect(normalizeClaudeModelSelection('OpusPlan')).toBe('opusplan');
  });

  it('normalizes common human shorthand to safe Claude selections', () => {
    expect(normalizeClaudeModelSelection('opus-4-7')).toBe('opus');
    expect(normalizeClaudeModelSelection('opus-4.7')).toBe('opus');
    expect(normalizeClaudeModelSelection('opus-4-6')).toBe(
      CLAUDE_MODEL_PINS.opus,
    );
    expect(normalizeClaudeModelSelection('sonnet-4-6')).toBe(
      CLAUDE_MODEL_PINS.sonnet,
    );
    expect(normalizeClaudeModelSelection('haiku-4-5')).toBe(
      CLAUDE_MODEL_PINS.haiku,
    );
  });

  it('leaves unknown provider model IDs untouched for Claude validation', () => {
    expect(normalizeClaudeModelSelection('custom-provider-model')).toBe(
      'custom-provider-model',
    );
  });
});
