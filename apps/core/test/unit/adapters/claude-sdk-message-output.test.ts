import { describe, expect, it } from 'vitest';

import { sdkResultText } from '../../../src/adapters/llm/anthropic-claude-agent/runner/sdk-message-output.js';

describe('sdkResultText', () => {
  it('preserves non-empty plain-text results from SDK error frames when allowed', () => {
    expect(
      sdkResultText(
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'research output',
        },
        undefined,
        { allowErrorResultText: true },
      ),
    ).toBe('research output');
  });

  it('keeps structured outputs strict even when SDK error text fallback is allowed', () => {
    expect(() =>
      sdkResultText(
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'not json',
        },
        { type: 'object' },
        { allowErrorResultText: true },
      ),
    ).toThrow('Claude SDK returned success without validated structured output.');
  });
});
