import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
}));
const runnerOutputs = vi.hoisted(() => [] as Record<string, unknown>[]);
const claudeSdkPackage = vi.hoisted(() =>
  ['@anthropic-ai', 'claude-agent-sdk'].join('/'),
);

vi.hoisted(() => {
  process.env.GANTRY_WORKSPACE_GROUP_DIR ??= '/tmp';
  process.env.GANTRY_WORKSPACE_EXTRA_DIR ??= '/tmp';
  process.env.GANTRY_IPC_DIR ??= '/tmp';
  process.env.GANTRY_IPC_INPUT_DIR ??= '/tmp';
});

vi.mock(claudeSdkPackage, () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: 'dynamic-boundary',
  query: sdk.query,
}));
vi.mock('@core/adapters/llm/anthropic-claude-agent/runner/output.js', () => ({
  writeOutput: (output: Record<string, unknown>) => runnerOutputs.push(output),
}));

import { usageEventIdForMessage } from '@core/adapters/llm/anthropic-claude-agent/runner/query-usage-event-id.js';
import { runQuery } from '@core/adapters/llm/anthropic-claude-agent/runner/query-loop.js';
import { recordSuccessfulToolUse } from '@core/adapters/llm/anthropic-claude-agent/runner/tool-success-ledger.js';
import type { AgentRunnerInput } from '@core/adapters/llm/anthropic-claude-agent/runner/types.js';
import { canonicalGantryToolRuleName } from '@core/shared/gantry-tool-facades.js';
import { RunScopedToolSuccessLedger } from '@core/runner/tool-gate-core.js';

function runnerInput(
  overrides: Partial<AgentRunnerInput> = {},
): AgentRunnerInput {
  return {
    prompt: 'ignored',
    workspaceFolder: 'workspace',
    chatJid: 'app:test',
    permissionMode: 'deny',
    ...overrides,
  };
}

beforeEach(() => {
  runnerOutputs.length = 0;
});

describe('Claude query loop live structured completion', () => {
  it('emits a turn-complete marker after a structured result', async () => {
    sdk.query.mockImplementation(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const messages = prompt[Symbol.asyncIterator]();
        await messages.next();
        yield {
          type: 'result',
          subtype: 'success',
          structured_output: { answer: 'INR 62,00,000' },
        };
        expect(await messages.next()).toEqual({ done: true, value: undefined });
      },
    }));

    await runQuery(
      'prompt',
      '/tmp/gantry-mcp-server.js',
      runnerInput({ responseSchema: { type: 'object' } }),
      {},
      'claude-test',
      undefined,
      undefined,
      { enableIpcFollowups: true, persistSdkSession: true },
    );

    const resultIndex = runnerOutputs.findIndex(
      (output) => output.result === '{"answer":"INR 62,00,000"}',
    );
    expect(resultIndex).toBeGreaterThanOrEqual(0);
    expect(
      runnerOutputs
        .slice(resultIndex + 1)
        .some(
          (output) =>
            output.status === 'success' &&
            output.result === null &&
            !output.runtimeEventOnly,
        ),
    ).toBe(true);
  });
});

describe('Claude query loop usage event IDs', () => {
  it('uses stable provider IDs when present', () => {
    expect(
      usageEventIdForMessage({ request_id: 'req-1' }, 'session-1', 1, 'run-a'),
    ).toBe('req-1');
  });

  it('keeps fallback usage IDs unique across resumed query runs', () => {
    expect(usageEventIdForMessage({}, 'session-1', 1, 'run-a')).toBe(
      'session-1:run:run-a:result:1',
    );
    expect(usageEventIdForMessage({}, 'session-1', 1, 'run-b')).toBe(
      'session-1:run:run-b:result:1',
    );
  });
});

describe('Claude query loop SDK result failures', () => {
  it('reports SDK result failures before missing structured output', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'error_max_structured_output_retries',
          errors: ['Structured output did not match the schema.'],
        };
      },
    });

    await expect(
      runQuery(
        'prompt',
        '/tmp/gantry-mcp-server.js',
        runnerInput({ responseSchema: { type: 'object' } }),
        {},
        'claude-test',
        undefined,
        undefined,
        { enableIpcFollowups: false, persistSdkSession: false },
      ),
    ).rejects.toThrow('Structured output did not match the schema.');
  });

  it('reports SDK success-subtyped error results before missing structured output', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'Provider failed before structured output was produced.',
        };
      },
    });

    await expect(
      runQuery(
        'prompt',
        '/tmp/gantry-mcp-server.js',
        runnerInput({ responseSchema: { type: 'object' } }),
        {},
        'claude-test',
        undefined,
        undefined,
        { enableIpcFollowups: false, persistSdkSession: false },
      ),
    ).rejects.toThrow(
      'Claude SDK returned error result: Provider failed before structured output was produced.',
    );
  });
});

describe('Claude query loop declarative tool names', () => {
  it('canonicalizes first-party Gantry MCP names to bare rule names', () => {
    expect(canonicalGantryToolRuleName('mcp__gantry__send_message')).toBe(
      'send_message',
    );
  });

  it.each([
    'mcp__gantry__delegate_task',
    'mcp__gantry__task_message',
    'delegate_task',
    'task_message',
  ])('canonicalizes %s as AgentDelegation', (toolName) => {
    expect(canonicalGantryToolRuleName(toolName)).toBe('AgentDelegation');
  });

  it('keeps non-Gantry MCP names unchanged', () => {
    expect(canonicalGantryToolRuleName('mcp__crm__delete')).toBe(
      'mcp__crm__delete',
    );
  });

  it('keeps native tool names unchanged', () => {
    expect(canonicalGantryToolRuleName('Bash')).toBe('Bash');
  });
});

describe('Claude query loop declarative tool success ledger', () => {
  it.each([
    ['is_error', { is_error: true }],
    ['isError', { isError: true }],
    ['structured error envelope', { error: { category: 'business' } }],
  ])(
    'does not record %s tool responses as successes',
    (_label, toolResponse) => {
      const ledger = new RunScopedToolSuccessLedger();

      recordSuccessfulToolUse(
        { tool_name: 'mcp__gantry__send_message', tool_response: toolResponse },
        ledger,
      );

      expect(ledger.hasSuccess('send_message')).toBe(false);
    },
  );

  it('records successful tool responses', () => {
    const ledger = new RunScopedToolSuccessLedger();

    recordSuccessfulToolUse(
      {
        tool_name: 'mcp__gantry__send_message',
        tool_response: { content: [{ type: 'text', text: 'sent' }] },
      },
      ledger,
    );

    expect(ledger.hasSuccess('send_message')).toBe(true);
  });
});
