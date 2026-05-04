import { describe, expect, it } from 'vitest';

import {
  anyToolRuleMatches,
  validateAutonomousToolRule,
} from '@core/shared/tool-rule-matcher.js';

describe('autonomous tool rule matcher', () => {
  it('supports exact tool names and mcp server wildcards', () => {
    expect(anyToolRuleMatches(['Bash'], 'Bash')).toBe(true);
    expect(anyToolRuleMatches(['Bash'], 'Read')).toBe(false);
    expect(anyToolRuleMatches(['mcp__github__*'], 'mcp__github__search')).toBe(
      true,
    );
    expect(anyToolRuleMatches(['mcp__github__*'], 'mcp__linear__search')).toBe(
      false,
    );
  });

  it('rejects empty, global, and unsupported wildcard rules', () => {
    expect(validateAutonomousToolRule('').ok).toBe(false);
    expect(validateAutonomousToolRule('*').ok).toBe(false);
    expect(validateAutonomousToolRule('mcp__github__search*').ok).toBe(false);
    expect(validateAutonomousToolRule('mcp__github__*').ok).toBe(true);
  });
});
