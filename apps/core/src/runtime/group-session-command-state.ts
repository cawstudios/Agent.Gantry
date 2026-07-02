import { randomUUID } from 'node:crypto';

import type {
  AsyncTaskRecord,
  AsyncTaskRepository,
} from '../domain/ports/async-tasks.js';
import type { RuntimeAgentSessionRepository } from '../domain/repositories/ops-repo.js';
import type { NewMessage } from '../domain/types.js';
import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
import {
  isSenderControlAllowed,
  isTriggerAllowed,
  loadSenderControlAllowlist,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';
import { archiveCurrentRuntimeSession } from './session-resume-runtime.js';
import { saveGroupProcedureMemory } from './group-memory-commands.js';
import { resolveRuntimeExecutionProviderId } from './execution-provider-id.js';
import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';

type ArchiveSessionInput = Parameters<typeof archiveCurrentRuntimeSession>[0];
type SenderPolicyGroup = {
  folder: string;
  requiresTrigger?: boolean;
};
const SESSION_COMPACTION_TIMEOUT_MS = 10 * 60_000;

export function createAdvanceCursorHandler(input: {
  queueJid: string;
  setCursor: (chatJid: string, timestamp: string) => void;
  saveState: () => Promise<void> | void;
  warn: (err: unknown) => void;
}) {
  return (message: Pick<NewMessage, 'timestamp' | 'id'>) => {
    input.setCursor(
      input.queueJid,
      encodeGroupMessageCursor(toGroupMessageCursor(message)),
    );
    void Promise.resolve(input.saveState()).catch(input.warn);
  };
}

export function createArchiveCurrentSessionHandler(input: {
  ops: () => RuntimeAgentSessionRepository;
  appId?: string;
  group: ArchiveSessionInput['group'];
  chatJid: string;
  threadId: string | null;
  defaultScope: 'user' | 'group';
  memoryUserId?: string;
  collectMemory?: SessionMemoryCollector;
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
}) {
  return async (cause: ArchiveSessionInput['cause'] = 'new-session') => {
    await archiveCurrentRuntimeSession({
      ops: input.ops(),
      appId: input.appId,
      group: input.group,
      chatJid: input.chatJid,
      threadId: input.threadId,
      cause,
      defaultScope: input.defaultScope,
      memoryUserId: input.memoryUserId,
      executionProviderId: resolveRuntimeExecutionProviderId(
        input.executionAdapter,
      ),
      ...(input.collectMemory ? { collectMemory: input.collectMemory } : {}),
    });
  };
}

export function createPrepareSessionArchiveHandler(input: {
  ops: () => RuntimeAgentSessionRepository;
  appId?: string;
  group: ArchiveSessionInput['group'];
  chatJid: string;
  threadId: string | null;
  defaultScope: 'user' | 'group';
  memoryUserId?: string;
  collectMemory?: SessionMemoryCollector;
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
}) {
  return async (_cause: 'new-session') => {
    const ops = input.ops();
    const turnContext = await ops.getAgentTurnContext?.({
      appId: input.appId,
      agentFolder: input.group.folder,
      executionProviderId: resolveRuntimeExecutionProviderId(
        input.executionAdapter,
      ),
      conversationJid: input.chatJid,
      providerAccountId: input.group.providerAccountId,
      threadId: input.threadId,
      conversationKind: input.group.conversationKind,
      memoryUserId: input.memoryUserId,
      hydrateMemory: false,
    });
    if (!turnContext?.agentSessionId || !input.collectMemory) {
      return undefined;
    }
    const agentSessionId = turnContext.agentSessionId;
    return async () => {
      await input.collectMemory?.({
        agentSessionId,
        trigger: 'session-end',
        defaultScope: input.defaultScope,
      });
    };
  };
}

export function createSessionArchiveHandlers(
  input: Parameters<typeof createArchiveCurrentSessionHandler>[0],
) {
  return {
    archiveCurrentSession: createArchiveCurrentSessionHandler(input),
    prepareSessionArchive: createPrepareSessionArchiveHandler(input),
  };
}

export function createSessionCompactionHandlers(
  input: Parameters<typeof createArchiveCurrentSessionHandler>[0] & {
    getAsyncTaskRepository?: () => AsyncTaskRepository | undefined;
  },
) {
  const getContext = async () => {
    const ops = input.ops();
    const executionProviderId = resolveRuntimeExecutionProviderId(
      input.executionAdapter,
    );
    const context = await ops.getAgentTurnContext?.({
      appId: input.appId,
      agentFolder: input.group.folder,
      executionProviderId,
      conversationJid: input.chatJid,
      providerAccountId: input.group.providerAccountId,
      threadId: input.threadId,
      conversationKind: input.group.conversationKind,
      memoryUserId: input.memoryUserId,
      hydrateMemory: false,
    });
    const repository = input.getAsyncTaskRepository?.();
    return { ops, executionProviderId, context, repository };
  };
  const releaseStaleTaskLocks = async (tasks: AsyncTaskRecord[]) => {
    if (tasks.length === 0) return;
    const { ops, executionProviderId } = await getContext();
    if (!ops.finishProviderSessionMaintenance) return;
    await Promise.all(
      tasks.map((task) =>
        releaseCompactionLockFromTask(ops, executionProviderId, task),
      ),
    );
  };
  return {
    admitSessionCompactionTask: async () => {
      const { context, repository } = await getContext();
      if (!repository?.createTaskWithScopedAdmission || !context?.agentId) {
        return undefined;
      }
      const now = new Date().toISOString();
      const staleBefore = new Date(
        Date.now() - SESSION_COMPACTION_TIMEOUT_MS,
      ).toISOString();
      const result = await repository.createTaskWithScopedAdmission({
        task: {
          id: `task_${randomUUID()}`,
          appId: input.appId ?? context.appId,
          agentId: context.agentId,
          conversationId: input.chatJid,
          threadId: input.threadId,
          kind: 'session_compaction',
          status: 'queued',
          admissionClass: 'task',
          authoritySnapshotJson: {
            internal: true,
            command: '/compact',
          },
          privateCorrelationJson: {
            agentSessionId: context.agentSessionId,
            scopeKey: `${input.chatJid}:${input.threadId ?? ''}`,
          },
          leaseToken: randomUUID(),
          fencingVersion: 1,
          summary: 'Session compaction',
          now,
        },
        activeStatuses: ['queued', 'running'],
        staleRunningBefore: staleBefore,
        staleRunningStatus: 'timed_out',
        staleErrorSummary: 'Session compaction exceeded the 10 minute timeout.',
      });
      await releaseStaleTaskLocks(result.staleTasks);
      return { task: result.task, admitted: result.admitted };
    },
    beginSessionCompaction: async (input?: { baseCursor?: string }) => {
      const { ops, executionProviderId, context } = await getContext();
      if (
        !context?.providerSessionId ||
        !context.externalSessionId ||
        !ops.markProviderSessionMaintenance
      )
        return undefined;
      const locked = await ops.markProviderSessionMaintenance({
        providerSessionId: context.providerSessionId,
        agentSessionId: context.agentSessionId,
        provider: executionProviderId,
        externalSessionId: context.externalSessionId,
        compactionBaseCursor: input?.baseCursor ?? null,
      });
      return locked
        ? {
            providerSessionId: context.providerSessionId,
            externalSessionId: context.externalSessionId,
          }
        : undefined;
    },
    markSessionCompactionTaskRunning: async (
      task: AsyncTaskRecord,
      locked: { providerSessionId: string; externalSessionId: string },
    ) => {
      const { repository, executionProviderId, context } = await getContext();
      if (!repository) return null;
      return repository.transitionTask({
        taskId: task.id,
        leaseToken: task.leaseToken,
        fencingVersion: task.fencingVersion,
        status: 'running',
        now: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        privateCorrelationJson: {
          ...task.privateCorrelationJson,
          provider: executionProviderId,
          agentSessionId: context?.agentSessionId,
          providerSessionId: locked.providerSessionId,
          externalSessionId: locked.externalSessionId,
        },
      });
    },
    heartbeatSessionCompactionTask: async (
      task: AsyncTaskRecord | undefined,
    ) => {
      if (!task) return null;
      const { repository } = await getContext();
      if (!repository) return null;
      const now = new Date().toISOString();
      return repository.transitionTask({
        taskId: task.id,
        leaseToken: task.leaseToken,
        fencingVersion: task.fencingVersion,
        status: 'running',
        now,
        heartbeatAt: now,
      });
    },
    finishSessionCompactionTask: async (
      task: AsyncTaskRecord | undefined,
      outcome: 'ready' | 'degraded' | 'failed',
    ) => {
      if (!task) return;
      const { repository } = await getContext();
      if (!repository) return;
      const now = new Date().toISOString();
      const terminal =
        outcome === 'failed'
          ? { errorSummary: 'Session compaction did not finish.' }
          : { outputSummary: outcome, errorSummary: null };
      await repository.transitionTask({
        taskId: task.id,
        leaseToken: task.leaseToken,
        fencingVersion: task.fencingVersion,
        status: outcome === 'failed' ? 'failed' : 'completed',
        now,
        terminalAt: now,
        ...terminal,
      });
    },
    getSessionCompactionStatus: async () => {
      const { context, repository } = await getContext();
      if (context?.latestProviderSessionLocked)
        return { state: 'running' as const };
      if (context?.latestProviderSessionReady)
        return { state: 'ready' as const };
      const taskStatus = repository
        ? await latestCompactionTaskStatus(repository, {
            appId: input.appId ?? context?.appId,
            agentId: context?.agentId,
            conversationId: input.chatJid,
            threadId: input.threadId,
          })
        : undefined;
      if (taskStatus) return { state: taskStatus };
      return { state: 'idle' as const };
    },
    finishSessionCompaction: async (
      locked:
        | { providerSessionId: string; externalSessionId: string }
        | undefined,
      status: 'active' | 'expired' | 'ready',
    ) => {
      if (!locked) return;
      const { ops, executionProviderId, context } = await getContext();
      if (!ops.finishProviderSessionMaintenance) return;
      if (!context?.agentSessionId) return;
      await ops.finishProviderSessionMaintenance({
        providerSessionId: locked.providerSessionId,
        agentSessionId: context.agentSessionId,
        provider: executionProviderId,
        externalSessionId: locked.externalSessionId,
        status,
      });
    },
  };
}

async function latestCompactionTaskStatus(
  repository: AsyncTaskRepository,
  scope: {
    appId?: string;
    agentId?: string;
    conversationId: string;
    threadId: string | null;
  },
): Promise<
  'queued' | 'running' | 'ready' | 'degraded' | 'failed' | 'timeout' | undefined
> {
  if (!scope.appId || !scope.agentId) return undefined;
  const [task] = await repository.listTasks({
    appId: scope.appId,
    agentId: scope.agentId,
    conversationId: scope.conversationId,
    threadId: scope.threadId,
    kind: 'session_compaction',
    limit: 1,
  });
  if (!task) return undefined;
  if (task.status === 'queued' || task.status === 'running') {
    return task.status;
  }
  if (task.status === 'timed_out') return 'timeout';
  if (task.status === 'failed' || task.status === 'cancelled') return 'failed';
  if (task.status === 'completed') {
    return task.outputSummary === 'degraded' ? 'degraded' : 'ready';
  }
  return undefined;
}

async function releaseCompactionLockFromTask(
  ops: RuntimeAgentSessionRepository,
  fallbackProvider: string,
  task: AsyncTaskRecord,
): Promise<void> {
  const data = task.privateCorrelationJson;
  const providerSessionId = stringValue(data.providerSessionId);
  const agentSessionId = stringValue(data.agentSessionId);
  const externalSessionId = stringValue(data.externalSessionId);
  if (!providerSessionId || !agentSessionId || !externalSessionId) return;
  await ops.finishProviderSessionMaintenance?.({
    providerSessionId,
    agentSessionId,
    provider: stringValue(data.provider) ?? fallbackProvider,
    externalSessionId,
    status: 'expired',
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function createSaveProcedureHandler(input: {
  folder: string;
  conversationId: string;
  userId?: string;
  defaultScope: 'user' | 'group';
  threadId?: string | null;
  isAdminWrite: boolean;
}) {
  return async ({ title, body }: { title: string; body: string }) =>
    saveGroupProcedureMemory({
      folder: input.folder,
      conversationId: input.conversationId,
      userId: input.userId,
      defaultScope: input.defaultScope,
      threadId: input.threadId,
      isAdminWrite: input.isAdminWrite,
      title,
      body,
    } as Parameters<typeof saveGroupProcedureMemory>[0]);
}

export function createSenderCommandPolicy(input: {
  chatJid: string;
  group: SenderPolicyGroup;
  triggerPattern: RegExp;
}) {
  return {
    isSenderControlAllowlisted: (msg: NewMessage) =>
      isSenderControlAllowed(
        input.chatJid,
        msg.sender,
        loadSenderControlAllowlist(),
        input.group.folder,
      ),
    canSenderInteract: (msg: NewMessage) => {
      const hasTrigger = input.triggerPattern.test(msg.content.trim());
      const reqTrigger = input.group.requiresTrigger !== false;
      return (
        !reqTrigger ||
        (hasTrigger &&
          (msg.is_from_me ||
            isTriggerAllowed(
              input.chatJid,
              msg.sender,
              loadSenderAllowlist(),
              input.group.folder,
            )))
      );
    },
  };
}
