import { describe, expect, it } from 'vitest';

import { claudeSdkToolsForEnabledSkills } from '@core/adapters/llm/anthropic-claude-agent/native-sdk-skills.js';

describe('native SDK skills', () => {
  it('does not expose the native Skill tool when SDK skills are eager', () => {
    expect(
      claudeSdkToolsForEnabledSkills(['ToolSearch'], ['boondi-gifting'], []),
    ).toEqual(['ToolSearch']);
  });

  it('exposes the native Skill tool when progressive SDK skills are enabled under a restricted tool surface', () => {
    expect(
      claudeSdkToolsForEnabledSkills(
        ['ToolSearch'],
        ['boondi-gifting', 'boondi-product-care', 'boondi-orders'],
        ['boondi-gifting'],
      ),
    ).toEqual(['ToolSearch', 'Skill']);
  });

  it('does not expose Skill when no SDK skills are enabled', () => {
    expect(claudeSdkToolsForEnabledSkills(['ToolSearch'], [], [])).toEqual([
      'ToolSearch',
    ]);
  });
});
