import { describe, expect, it, vi } from 'vitest';

import {
  CALLABLE_AGENT_TOOL_PREFIX,
  dispatchCallableAgentTool,
  projectCallableAgentTools,
} from '@core/application/core-tools/callable-agent-tools.js';
import type { Agent } from '@core/domain/agent/agent.js';
import type { CoreTaskLifecycleBackend } from '@core/application/core-tools/task-lifecycle.js';
import type { CoreSendMessageDeps } from '@core/application/core-tools/send-message.js';

function agent(
  id: string,
  options: Partial<Pick<Agent, 'appId' | 'name' | 'status'>> = {},
): Agent {
  return {
    id,
    appId: options.appId ?? 'default',
    name: options.name ?? id,
    status: options.status ?? 'active',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as Agent;
}

function backend(): CoreTaskLifecycleBackend {
  return {
    owner: {
      appId: 'default',
      agentId: 'agent:main_agent',
      conversationId: 'conversation:origin',
      providerAccountId: 'slack_beta',
      threadId: 'thread-1',
    },
    delegate_task: vi.fn(async () => ({ ok: true, message: 'queued' })),
    task_get: vi.fn(),
    task_list: vi.fn(),
    task_cancel: vi.fn(),
    task_message: vi.fn(),
  } as CoreTaskLifecycleBackend;
}

function narration(
  sendMessage: CoreSendMessageDeps['sendMessage'],
  warn = vi.fn(),
) {
  return {
    sourceAgentFolder: 'main_agent',
    deps: { sendMessage, warn },
  };
}

describe('callable agent tools', () => {
  it('projects only active same-app non-self allowlisted agents', () => {
    const projected = projectCallableAgentTools({
      agents: [
        agent('agent:main_agent'),
        agent('agent:reviewer', { name: 'Review\nAgent' }),
        agent('agent:disabled', { status: 'disabled' }),
        agent('agent:other-app', { appId: 'other' }),
        agent('agent:unlisted'),
      ],
      callerAppId: 'default',
      callerAgentId: 'agent:main_agent',
      callerFolder: 'main_agent',
      delegates: [
        'reviewer',
        'agent:reviewer',
        'disabled',
        'other-app',
        'main_agent',
      ],
      toolPolicyRules: ['AgentDelegation'],
    });

    expect(projected).toEqual([
      expect.objectContaining({
        targetAgentId: 'agent:reviewer',
        displayName: 'Review Agent',
      }),
    ]);
  });

  it('uses bounded collision-safe names derived from immutable identity', () => {
    const projected = projectCallableAgentTools({
      agents: [agent('agent:same-name-a'), agent('agent:same-name-b')],
      callerAppId: 'default',
      callerAgentId: 'agent:main_agent',
      callerFolder: 'main_agent',
      delegates: ['same-name-a', 'same-name-b'],
      toolPolicyRules: ['AgentDelegation'],
    });

    expect(new Set(projected.map(({ toolName }) => toolName)).size).toBe(2);
    expect(
      projected.every(
        ({ toolName }) =>
          `${CALLABLE_AGENT_TOOL_PREFIX}${toolName}`.length <= 64,
      ),
    ).toBe(true);
  });

  it.each([
    { parentTaskId: 'task-parent', toolPolicyRules: ['AgentDelegation'] },
    { parentTaskId: undefined, toolPolicyRules: [] },
  ])('suppresses projection without top-level delegation authority', (run) => {
    expect(
      projectCallableAgentTools({
        agents: [agent('agent:reviewer')],
        callerAppId: 'default',
        callerAgentId: 'agent:main_agent',
        callerFolder: 'main_agent',
        delegates: ['reviewer'],
        ...run,
      }),
    ).toEqual([]);
  });

  it('injects the pinned target after current eligibility revalidation', async () => {
    const taskBackend = backend();
    const revalidate = vi.fn(async () => true);
    const entry = {
      toolName: 'reviewer_hash',
      targetAgentId: 'agent:reviewer',
      displayName: 'Reviewer',
    };

    await expect(
      dispatchCallableAgentTool({
        args: { objective: 'Review this', timeoutMs: 1234 },
        entry,
        backend: taskBackend,
        revalidate,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(taskBackend.delegate_task).toHaveBeenCalledWith({
      objective: 'Review this',
      timeoutMs: 1234,
      syncWaitTimeoutMs: 60_000,
      targetAgentId: 'agent:reviewer',
    });
  });

  it('narrates delegation start and sync completion on the owner route', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const taskBackend = backend();
    vi.mocked(taskBackend.delegate_task).mockResolvedValue({
      ok: true,
      message: 'Specialist result',
      data: { status: 'completed' },
    });

    await expect(
      dispatchCallableAgentTool({
        args: { objective: 'Review this' },
        entry: {
          toolName: 'reviewer_hash',
          targetAgentId: 'agent:reviewer',
          displayName: 'Reviewer',
        },
        backend: taskBackend,
        revalidate: vi.fn(async () => true),
        narration: narration(sendMessage),
      }),
    ).resolves.toEqual({
      ok: true,
      message: 'Specialist result',
      data: { status: 'completed' },
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      'conversation:origin',
      'Checking with the Reviewer agent…',
      expect.objectContaining({
        providerAccountId: 'slack_beta',
        threadId: 'thread-1',
      }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      'conversation:origin',
      'Reviewer responded.',
      expect.objectContaining({
        providerAccountId: 'slack_beta',
        threadId: 'thread-1',
      }),
    );
  });

  it('narrates the async fallback without posting a transcript', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const taskBackend = backend();
    vi.mocked(taskBackend.delegate_task).mockResolvedValue({
      ok: true,
      message: 'Queued: task-running',
      data: { taskId: 'task-running', status: 'running' },
    });

    await dispatchCallableAgentTool({
      args: { objective: 'Review this' },
      entry: {
        toolName: 'reviewer_hash',
        targetAgentId: 'agent:reviewer',
        displayName: 'Reviewer',
      },
      backend: taskBackend,
      revalidate: vi.fn(async () => true),
      narration: narration(sendMessage),
    });

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      'Checking with the Reviewer agent…',
      "Reviewer is still working; I'll follow up.",
    ]);
  });

  it('warns and keeps delegation fail-open when narration delivery rejects', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('delivery unavailable');
    });
    const warn = vi.fn();
    const delegatedResult = {
      ok: true,
      message: 'Specialist result',
      data: { taskId: 'task-1', status: 'completed' },
    };
    const taskBackend = backend();
    vi.mocked(taskBackend.delegate_task).mockResolvedValue(delegatedResult);

    await expect(
      dispatchCallableAgentTool({
        args: { objective: 'Review this' },
        entry: {
          toolName: 'reviewer_hash',
          targetAgentId: 'agent:reviewer',
          displayName: 'Reviewer',
        },
        backend: taskBackend,
        revalidate: vi.fn(async () => true),
        narration: narration(sendMessage, warn),
      }),
    ).resolves.toBe(delegatedResult);
    expect(taskBackend.delegate_task).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ error: 'delivery unavailable' }),
      'Callable-agent narration delivery failed',
    );
  });

  it('bounds start narration before delegating when delivery stalls', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => new Promise<void>(() => {}));
    const warn = vi.fn();
    const delegatedResult = {
      ok: true,
      message: 'Specialist result',
    };
    const taskBackend = backend();
    vi.mocked(taskBackend.delegate_task).mockResolvedValue(delegatedResult);
    const revalidate = vi.fn(async () => true);

    try {
      const dispatched = dispatchCallableAgentTool({
        args: { objective: 'Review this' },
        entry: {
          toolName: 'reviewer_hash',
          targetAgentId: 'agent:reviewer',
          displayName: 'Reviewer',
        },
        backend: taskBackend,
        revalidate,
        narration: narration(sendMessage, warn),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(revalidate).toHaveBeenCalledOnce();
      expect(taskBackend.delegate_task).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4_999);

      expect(revalidate).toHaveBeenCalledOnce();
      expect(taskBackend.delegate_task).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(revalidate).toHaveBeenCalledTimes(2);
      expect(taskBackend.delegate_task).toHaveBeenCalledOnce();
      expect(revalidate.mock.invocationCallOrder[1]).toBeLessThan(
        vi.mocked(taskBackend.delegate_task).mock.invocationCallOrder[0]!,
      );
      await expect(dispatched).resolves.toBe(delegatedResult);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ error: 'Narration delivery timed out.' }),
        'Callable-agent narration delivery failed',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not narrate a rejected call that never delegates', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const taskBackend = backend();

    await dispatchCallableAgentTool({
      args: { objective: 'Review this' },
      entry: {
        toolName: 'reviewer_hash',
        targetAgentId: 'agent:reviewer',
        displayName: 'Reviewer',
      },
      backend: taskBackend,
      revalidate: vi.fn(async () => false),
      narration: narration(sendMessage),
    });

    expect(taskBackend.delegate_task).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not delegate when eligibility is revoked immediately before dispatch', async () => {
    let resolveRevalidation!: (eligible: boolean) => void;
    const finalRevalidation = new Promise<boolean>((resolve) => {
      resolveRevalidation = resolve;
    });
    const sendMessage = vi.fn(async () => undefined);
    const taskBackend = backend();
    const revalidate = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => finalRevalidation);

    const dispatched = dispatchCallableAgentTool({
      args: { objective: 'Review this' },
      entry: {
        toolName: 'reviewer_hash',
        targetAgentId: 'agent:reviewer',
        displayName: 'Reviewer',
      },
      backend: taskBackend,
      revalidate,
      narration: narration(sendMessage),
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(taskBackend.delegate_task).not.toHaveBeenCalled();

    resolveRevalidation(false);

    await expect(dispatched).resolves.toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(taskBackend.delegate_task).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      'Checking with the Reviewer agent…',
      'Reviewer is no longer available.',
    ]);
  });

  it('rejects target overrides and stale target eligibility', async () => {
    const taskBackend = backend();
    const entry = {
      toolName: 'reviewer_hash',
      targetAgentId: 'agent:reviewer',
      displayName: 'Reviewer',
    };

    await expect(
      dispatchCallableAgentTool({
        args: {
          objective: 'Review this',
          targetAgentId: 'agent:attacker',
        },
        entry,
        backend: taskBackend,
        revalidate: vi.fn(async () => true),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    await expect(
      dispatchCallableAgentTool({
        args: { objective: 'Review this' },
        entry,
        backend: taskBackend,
        revalidate: vi.fn(async () => false),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'forbidden' });
    expect(taskBackend.delegate_task).not.toHaveBeenCalled();
  });
});
