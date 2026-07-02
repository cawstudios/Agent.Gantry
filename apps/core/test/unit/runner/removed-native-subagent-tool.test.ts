import { describe, expect, it } from 'vitest';

import { denyRemovedNativeSubagentTool } from '@core/adapters/llm/anthropic-claude-agent/runner/removed-native-subagent-tool.js';

describe('denyRemovedNativeSubagentTool', () => {
  it('hard-denies every native Task-family tool spelling', () => {
    for (const toolName of [
      'Task',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskOutput',
      'TaskStop',
      'TaskUpdate',
    ]) {
      expect(
        denyRemovedNativeSubagentTool({
          toolName,
          agentInput: { isScheduledJob: false } as never,
          getNewSessionId: () => undefined,
        }),
      ).toMatchObject({ behavior: 'deny', interrupt: false });
    }
  });
});
