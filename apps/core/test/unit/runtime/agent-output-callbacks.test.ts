import { describe, expect, it } from 'vitest';

import { isAgentTurnCompleteMarker } from '@core/runtime/agent-output-callbacks.js';
import type { AgentOutput } from '@core/runtime/agent-spawn-types.js';

describe('agent output callbacks', () => {
  it('treats final empty success events as turn completion markers even with usage', () => {
    const usageOnly = {
      status: 'success',
      result: null,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        totalBillableInputTokens: 60,
        cacheProvider: 'anthropic',
        cacheStatus: 'hit',
        at: new Date().toISOString(),
      },
    } satisfies AgentOutput;

    expect(isAgentTurnCompleteMarker(usageOnly)).toBe(true);
    expect(isAgentTurnCompleteMarker({ status: 'success', result: null })).toBe(
      true,
    );
  });
});
