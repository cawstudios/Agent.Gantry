import { describe, expect, it, vi } from 'vitest';

import { JobManagementService } from '@core/application/jobs/job-management-service.js';
import type { JobUpsertInput } from '@core/application/jobs/job-management-types.js';
import type { NewMessage, RegisteredGroup } from '@core/domain/types.js';
import { createGroupProcessor } from '@core/runtime/group-processing.js';
import type { GroupProcessingDeps } from '@core/runtime/group-processing-types.js';
import { runtimeJobSchedulePlanner } from '@core/jobs/job-schedule-planner.js';

function message(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'tg:-100',
    sender: 'tg:575',
    sender_name: 'Student',
    content: 'please summarize the thread',
    timestamp: '2026-05-04T00:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function group(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Ops Agent',
    folder: 'ops_agent',
    trigger: 'Ops',
    added_at: '2026-05-04T00:00:00.000Z',
    requiresTrigger: false,
    isMain: false,
    conversationKind: 'channel',
    ...overrides,
  };
}

function createMessageHarness(input: {
  chatJid: string;
  conversationKind: 'channel' | 'dm';
  content?: string;
  streaming?: boolean;
  allowedTools?: string[];
  result?: string;
}) {
  const sent: Array<{ jid: string; text: string; threadId?: string }> = [];
  const streams: Array<{ jid: string; text: string; done?: boolean }> = [];
  const runnerCalls: Array<{ group: RegisteredGroup; input: any }> = [];
  const messages = [
    message({
      id: `${input.chatJid}:msg-1`,
      chat_jid: input.chatJid,
      sender:
        input.conversationKind === 'dm'
          ? input.chatJid
          : `${input.chatJid}:user`,
      content: input.content ?? 'please summarize the thread',
      thread_id: input.chatJid.includes('threaded') ? 'thread-1' : undefined,
    } as Partial<NewMessage>),
  ];
  const testGroup = group({
    conversationKind: input.conversationKind,
    folder: input.chatJid.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, ''),
    isMain: input.conversationKind === 'dm',
    requiresTrigger: false,
  });
  const opsRepository = {
    getMessagesSince: vi.fn(async () => messages),
    getAgentTurnContext: vi.fn(async () => ({
      appId: 'app-one',
      agentId: 'agent-one',
      agentSessionId: 'session-one',
      memoryContextBlock: 'Previous user preference: concise replies.',
    })),
    createSessionAgentRun: vi.fn(async () => 'agent-run-1'),
    setSession: vi.fn(async () => undefined),
    storeMessage: vi.fn(async () => undefined),
  };
  const channelRuntime: GroupProcessingDeps['channelRuntime'] = {
    hasChannel: vi.fn(() => true),
    supportsStreaming: vi.fn(() => input.streaming === true),
    supportsProgress: vi.fn(() => false),
    sendMessage: vi.fn(async (jid, text, options) => {
      sent.push({ jid, text, threadId: options?.threadId });
    }),
    sendStreamingChunk: vi.fn(async (jid, text, options) => {
      streams.push({ jid, text, done: options?.done });
      return true;
    }),
    resetStreaming: vi.fn(),
    setTyping: vi.fn(),
    sendProgressUpdate: vi.fn(),
  };
  const deps: GroupProcessingDeps = {
    channelRuntime,
    getGroup: vi.fn(() => testGroup),
    clearSession: vi.fn(),
    getCursor: vi.fn(() => ''),
    setCursor: vi.fn(),
    saveState: vi.fn(),
    setGroupModelOverride: vi.fn(),
    setGroupThinkingOverride: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    getRegisteredJids: vi.fn(() => new Set([input.chatJid])),
    queue: {
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
      registerProcess: vi.fn(),
    },
    opsRepository: opsRepository as never,
    getToolRepository: () =>
      ({
        listAgentToolBindings: vi.fn(async () =>
          (input.allowedTools ?? []).map((toolId) => ({
            toolId,
            status: 'active',
          })),
        ),
        getTool: vi.fn(async (toolId: string) => ({
          name: toolId.replace(/^tool:/, ''),
        })),
      }) as never,
    runAgent: vi.fn(async (runGroup, runInput, _onProcess, onOutput) => {
      runnerCalls.push({ group: runGroup, input: runInput });
      const output = {
        status: 'success' as const,
        result: input.result ?? `reply for ${input.chatJid}`,
        newSessionId: 'provider-session-1',
      };
      await onOutput?.(output);
      return output;
    }),
  };
  return {
    processor: createGroupProcessor(deps),
    sent,
    streams,
    runnerCalls,
    opsRepository,
    channelRuntime,
  };
}

describe('runtime message round trips across providers and tool types', () => {
  const providerCases = [
    { name: 'Telegram channel', jid: 'tg:-100111', kind: 'channel' },
    { name: 'Telegram DM', jid: 'tg:575', kind: 'dm' },
    { name: 'Slack channel', jid: 'sl:C123', kind: 'channel' },
    { name: 'Slack DM', jid: 'sl:D123', kind: 'dm' },
    { name: 'Teams channel', jid: 'teams:team/channel', kind: 'channel' },
    { name: 'Teams DM', jid: 'teams:chat:abc', kind: 'dm' },
    { name: 'Web app channel', jid: 'app:workspace:general', kind: 'channel' },
    { name: 'Web app DM', jid: 'app:user:575', kind: 'dm' },
  ] as const;

  it.each(providerCases)(
    'round trips a user message through $name',
    async (scenario) => {
      const harness = createMessageHarness({
        chatJid: scenario.jid,
        conversationKind: scenario.kind,
      });

      await expect(
        harness.processor.processGroupMessages(scenario.jid),
      ).resolves.toBe(true);

      expect(harness.runnerCalls).toHaveLength(1);
      expect(harness.runnerCalls[0].input.chatJid).toBe(scenario.jid);
      expect(harness.runnerCalls[0].input.memoryDefaultScope).toBe(
        scenario.kind === 'dm' ? 'user' : 'group',
      );
      expect(harness.sent).toEqual([
        expect.objectContaining({
          jid: scenario.jid,
          text: `reply for ${scenario.jid}`,
        }),
      ]);
      expect(harness.opsRepository.setSession).toHaveBeenCalledWith(
        harness.runnerCalls[0].group.folder,
        'provider-session-1',
        null,
        { chatJid: scenario.jid },
      );
    },
  );

  const toolCases = [
    ['host messaging tool', ['tool:send_message']],
    ['host question tool', ['tool:ask_user_question']],
    ['permission tool', ['tool:request_permission']],
    ['service control tool', ['tool:service_restart']],
    ['browser tool', ['tool:agent_browser']],
    ['MCP tool', ['tool:mcp__linear__search_issues']],
  ] as const;

  it.each(toolCases)(
    'projects configured %s into a message turn',
    async (_label, tools) => {
      const harness = createMessageHarness({
        chatJid: 'app:workspace:tools',
        conversationKind: 'channel',
        allowedTools: [...tools],
      });

      await harness.processor.processGroupMessages('app:workspace:tools');

      expect(harness.runnerCalls[0].input.allowedTools).toEqual(
        tools.map((tool) => tool.replace(/^tool:/, '')),
      );
    },
  );

  it('streams a channel reply and finalizes the streaming turn', async () => {
    const harness = createMessageHarness({
      chatJid: 'sl:C-threaded',
      conversationKind: 'channel',
      streaming: true,
      result: 'streamed response',
    });

    await harness.processor.processGroupMessages('sl:C-threaded');

    expect(harness.channelRuntime.resetStreaming).toHaveBeenCalledWith(
      'sl:C-threaded',
    );
    expect(harness.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jid: 'sl:C-threaded',
          text: 'streamed response',
        }),
        expect.objectContaining({ jid: 'sl:C-threaded', text: '', done: true }),
      ]),
    );
  });
});

function createJobServiceHarness() {
  const upserts: JobUpsertInput[] = [];
  const syncs: string[] = [];
  const control = {
    getAppSessionById: vi.fn(async (sessionId: string) => ({
      sessionId,
      appId: 'app-one',
      chatJid: 'app:app-one:conversation-1',
      workspaceKey: 'agent-folder',
      defaultResponseMode: 'sync',
      defaultWebhookId: null,
    })),
  };
  const service = new JobManagementService({
    ops: {
      upsertJob: vi.fn(async (job: JobUpsertInput) => {
        upserts.push(job);
        return { created: true };
      }),
      getJobById: vi.fn(async () => undefined),
    } as never,
    scheduler: { requestSchedulerSync: vi.fn((jobId) => syncs.push(jobId)) },
    schedulePlanner: runtimeJobSchedulePlanner,
    clock: { now: () => '2026-05-04T00:00:00.000Z' },
    control: control as never,
  });
  return { service, upserts, syncs };
}

describe('deterministic scheduler job creation round trips', () => {
  it('creates a manual job for an app session and leaves it trigger-only', async () => {
    const harness = createJobServiceHarness();

    await harness.service.createJob({
      appId: 'app-one',
      sessionId: 'session-one',
      name: 'Manual audit',
      prompt: 'Audit the channel',
    });

    expect(harness.upserts[0]).toMatchObject({
      schedule_type: 'manual',
      schedule_value: 'manual',
      next_run: null,
      linked_sessions: ['app:app-one:conversation-1'],
      group_scope: 'agent-folder',
      created_by: 'human',
    });
    expect(harness.syncs).toEqual([harness.upserts[0].id]);
  });

  it('creates a one-time app job for the requested run time', async () => {
    const harness = createJobServiceHarness();

    await harness.service.createJob({
      appId: 'app-one',
      sessionId: 'session-one',
      name: 'One time audit',
      prompt: 'Run once',
      kind: 'once',
      runAt: '2026-05-04T10:00:00.000Z',
      threadId: 'thread-1',
    });

    expect(harness.upserts[0]).toMatchObject({
      schedule_type: 'once',
      schedule_value: '2026-05-04T10:00:00.000Z',
      next_run: '2026-05-04T10:00:00.000Z',
      thread_id: 'thread-1',
    });
  });

  it('creates a recurring cron job from IPC for bound channel conversations', async () => {
    const harness = createJobServiceHarness();

    await harness.service.upsertJobFromIpc({
      access: {
        sourceGroup: 'agent-folder',
        isMain: true,
        conversationBindings: { 'sl:C123': { folder: 'agent-folder' } },
      },
      name: 'Cron digest',
      prompt: 'Digest every morning',
      scheduleType: 'cron',
      scheduleValue: '0 9 * * *',
      linkedSessions: ['sl:C123'],
      groupScope: 'agent-folder',
    });

    expect(harness.upserts[0]).toMatchObject({
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      linked_sessions: ['sl:C123'],
      group_scope: 'agent-folder',
      created_by: 'agent',
      status: 'active',
    });
  });

  it('creates a recurring interval job from IPC for a DM conversation', async () => {
    const harness = createJobServiceHarness();

    await harness.service.upsertJobFromIpc({
      access: {
        sourceGroup: 'dm_agent',
        isMain: false,
        conversationBindings: { 'tg:575': { folder: 'dm_agent' } },
        sourceGroupJids: ['tg:575'],
      },
      name: 'DM reminder',
      prompt: 'Remind the user',
      scheduleType: 'interval',
      scheduleValue: '60000',
      linkedSessions: ['tg:575'],
      groupScope: 'dm_agent',
      executionMode: 'serialized',
    });

    expect(harness.upserts[0]).toMatchObject({
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: ['tg:575'],
      group_scope: 'dm_agent',
      execution_mode: 'serialized',
    });
  });

  it('rejects manual IPC jobs so agents cannot create invisible manual work', async () => {
    const harness = createJobServiceHarness();

    await expect(
      harness.service.upsertJobFromIpc({
        access: {
          sourceGroup: 'agent-folder',
          isMain: true,
          conversationBindings: {},
        },
        name: 'Bad manual',
        prompt: 'Should fail',
        scheduleType: 'manual',
        scheduleValue: 'manual',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCHEDULE' });
    expect(harness.upserts).toHaveLength(0);
  });
});
