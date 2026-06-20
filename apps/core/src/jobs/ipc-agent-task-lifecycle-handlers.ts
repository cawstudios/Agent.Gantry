import type { AgentTodoItem } from '../domain/ports/task-lifecycle.js';
import { AsyncCommandTaskService } from './async-command-task-service.js';
import type { AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import { nowIso } from '../shared/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskContext, TaskHandler } from './ipc-types.js';
import { resolveConfiguredAllowedTools } from '../runtime/configured-agent-tools.js';
import { NEUTRAL_CA_TRUST_ENV_KEYS } from '../shared/neutral-ca-trust-env.js';
import type { RunnerSandboxProvider } from '../shared/runner-sandbox-provider.js';
import type { RunnerSandboxResourceLimits } from '../shared/runner-sandbox-provider.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import type {
  AsyncCommandLaunchControl,
  AsyncCommandProcessHandle,
} from './async-command-task-service.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { readLiveToolRules } from '../shared/live-tool-rules.js';
import {
  readAsyncCommandSandboxPolicy,
  type AsyncCommandSandboxPolicy,
} from '../runtime/async-command-sandbox-policy.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeEgressGateway,
  ensureEgressGateway,
} from '../runtime/egress-gateway.js';

const TODO_STATUSES = new Set([
  'pending',
  'inProgress',
  'completed',
  'blocked',
]);
const MAX_TODO_ITEMS = 50;
const DEFAULT_ASYNC_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_ASYNC_RESOURCE_LIMITS: RunnerSandboxResourceLimits = {
  cpuSeconds: 300,
  memoryMb: 1024,
  maxProcesses: 64,
};
const ASYNC_COMMAND_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'GRPC_PROXY',
  'grpc_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'GODEBUG',
  'GANTRY_EGRESS_PROXY_URL',
  'NODE_EXTRA_CA_CERTS',
  ...NEUTRAL_CA_TRUST_ENV_KEYS,
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'USER',
  'SHELL',
  'TERM',
] as const;
const asyncCommandServices = new WeakMap<
  AsyncTaskRepository,
  AsyncCommandTaskService
>();

function responder(context: TaskContext) {
  return createTaskResponder(
    context.sourceAgentFolder,
    context.data.taskId,
    context.data.authThreadId,
    context.data.responseKeyId,
  );
}

function normalizeTodoItems(value: unknown): AgentTodoItem[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_TODO_ITEMS
  ) {
    return null;
  }
  const items: AgentTodoItem[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return null;
    const record = entry as Record<string, unknown>;
    const id = toTrimmedString(record.id, { maxLen: 80 });
    const title = toTrimmedString(record.title, { maxLen: 240 });
    const status = toTrimmedString(record.status, { maxLen: 32 });
    if (!id || !title || !status || !TODO_STATUSES.has(status) || ids.has(id)) {
      return null;
    }
    ids.add(id);
    const note = toTrimmedString(record.note, { maxLen: 500 });
    items.push({
      id,
      title,
      status: status as AgentTodoItem['status'],
      ...(note ? { note } : {}),
    });
  }
  return items;
}

function validateSameConversation(context: TaskContext): string | null {
  const conversationId = toTrimmedString(context.data.chatJid, {
    maxLen: 255,
  });
  if (
    !conversationId ||
    !context.sourceAgentFolderJids.includes(conversationId)
  ) {
    return null;
  }
  return conversationId;
}

function taskService(context: TaskContext): AsyncCommandTaskService | null {
  const repository = context.deps.getAsyncTaskRepository?.();
  const runnerSandboxProvider = context.deps.runnerSandboxProvider;
  if (!repository || !runnerSandboxProvider?.enforcing) return null;
  const existing = asyncCommandServices.get(repository);
  if (existing) return existing;
  const service = new AsyncCommandTaskService(
    repository,
    {
      run: async (input) =>
        runSandboxedAsyncCommand(runnerSandboxProvider, {
          ...input,
          cwd: input.cwd ?? process.cwd(),
          env: buildAsyncCommandEnv(),
          timeoutMs: DEFAULT_ASYNC_COMMAND_TIMEOUT_MS,
          outputMaxBytes: 4_000,
          protectedReadPaths: [...(input.protectedReadPaths ?? [])],
          protectedWritePaths: [...(input.protectedWritePaths ?? [])],
          allowedNetworkHosts: [...(input.allowedNetworkHosts ?? [])],
          egressProxyUrl: input.egressProxyUrl,
          resourceLimits: input.resourceLimits ?? DEFAULT_ASYNC_RESOURCE_LIMITS,
        }),
    },
    {
      prepareRun: async ({ task, allowedNetworkHosts }) => {
        const gateway = await ensureEgressGateway({
          key: `${task.appId}:${task.agentId}:${task.id}`,
          settings: context.deps.getEgressSettings?.() ?? { denylist: [] },
          principal: {
            appId: task.appId,
            agentId: task.agentId,
            ...(task.conversationId
              ? { conversationId: task.conversationId }
              : {}),
            ...(task.threadId ? { threadId: task.threadId } : {}),
            ...(task.parentRunId ? { runId: task.parentRunId } : {}),
            ...(task.parentJobId ? { jobId: task.parentJobId } : {}),
          },
          ...(allowedNetworkHosts && allowedNetworkHosts.length > 0
            ? { allowedNetworkHosts }
            : {}),
          ...(context.deps.publishRuntimeEvent
            ? { publishRuntimeEvent: context.deps.publishRuntimeEvent }
            : {}),
        });
        return {
          egressProxyUrl: gateway.proxyUrl,
          cleanup: () => closeEgressGateway(gateway),
        };
      },
    },
  );
  asyncCommandServices.set(repository, service);
  return service;
}

async function runSandboxedAsyncCommand(
  provider: RunnerSandboxProvider,
  input: {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    outputMaxBytes: number;
    protectedReadPaths: string[];
    protectedWritePaths: string[];
    allowedNetworkHosts: string[];
    egressProxyUrl?: string;
    resourceLimits: RunnerSandboxResourceLimits;
    signal: AbortSignal;
    appId: string;
    agentId: string;
    conversationId: string;
    threadId?: string | null;
    parentRunId?: string | null;
    parentJobId?: string | null;
    onProcessStarted?: (
      handle: AsyncCommandProcessHandle,
    ) => Promise<void> | void;
    launchControl?: AsyncCommandLaunchControl;
  },
): Promise<{ outputSummary?: string; errorSummary?: string }> {
  if (!provider.enforcing) {
    return Promise.reject(
      new Error(
        'Async command execution requires an enforcing runner sandbox.',
      ),
    );
  }
  if (input.signal.aborted) throw new Error('Command aborted.');
  const configFilePath = input.launchControl
    ? path.join(input.launchControl.directory, 'sandbox-runtime.json')
    : path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-async-command-')),
        'sandbox-runtime.json',
      );
  const child = provider.start({
    command: '/bin/sh',
    args: ['-c', asyncCommandLaunchScript()],
    cwd: input.cwd,
    workspaceRoot: input.cwd,
    configFilePath,
    egressProxyUrl: input.egressProxyUrl,
    allowedNetworkHosts: input.allowedNetworkHosts,
    runtimeReadPaths: [
      input.cwd,
      ...(input.launchControl ? [input.launchControl.directory] : []),
    ],
    runtimeWritePaths: [
      input.cwd,
      ...(input.launchControl ? [input.launchControl.directory] : []),
    ],
    protectedReadPaths: input.protectedReadPaths,
    protectedWritePaths: input.protectedWritePaths,
    resourceLimits: input.resourceLimits,
    sandboxProfile: {
      id: 'async-command',
      network: input.egressProxyUrl ? 'required' : 'none',
      filesystem: 'workspace_write',
    },
    principal: {
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId: input.threadId ?? undefined,
      runId: input.parentRunId ?? undefined,
      jobId: input.parentJobId ?? undefined,
    },
    env: {
      ...input.env,
      GANTRY_ASYNC_COMMAND_SCRIPT: input.command,
      ...(input.launchControl
        ? {
            GANTRY_ASYNC_LAUNCH_DIR: input.launchControl.directory,
            GANTRY_ASYNC_PID_FILE: input.launchControl.pidFile,
            GANTRY_ASYNC_PGID_FILE: input.launchControl.pgidFile,
            GANTRY_ASYNC_READY_FILE: input.launchControl.readyFile,
            GANTRY_ASYNC_CONTINUE_FILE: input.launchControl.continueFile,
          }
        : {}),
    },
  });
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    forceKillTimer.unref?.();
  };
  const onAbort = () => terminate();
  if (input.signal.aborted) {
    terminate();
    fs.rmSync(configFilePath, { force: true });
    throw new Error('Command aborted.');
  }
  input.signal.addEventListener('abort', onAbort, { once: true });
  let settled = false;
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<{
    outputSummary?: string;
    errorSummary?: string;
  }>((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal.removeEventListener('abort', onAbort);
      fs.rmSync(configFilePath, { force: true });
      fn();
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-input.outputMaxBytes);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-input.outputMaxBytes);
    });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code, signal) => {
      if (input.signal.aborted) {
        settle(() => reject(new Error('Command aborted.')));
        return;
      }
      if (timedOut) {
        settle(() =>
          reject(
            new Error(
              `Command timed out${signal ? ` with signal ${signal}` : ''}.`,
            ),
          ),
        );
        return;
      }
      if (code === 0) {
        child.kill('SIGTERM');
        const completionCleanupTimer = setTimeout(() => {
          child.kill('SIGKILL');
          settle(() =>
            resolve({
              outputSummary: stdout.trim() || 'command completed',
              errorSummary: stderr.trim(),
            }),
          );
        }, 1_000);
        completionCleanupTimer.unref?.();
        return;
      }
      settle(() =>
        reject(
          new Error(
            `Command failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
          ),
        ),
      );
    });
  });
  if (child.pid) {
    try {
      const processStartId = readProcessStartId(child.pid);
      await input.onProcessStarted?.({
        pid: child.pid,
        processGroupId: process.platform === 'win32' ? null : child.pid,
        detached: true,
        platform: process.platform,
        ownerPid: process.pid,
        startedAt: nowIso(),
        ...(processStartId ? { processStartId } : {}),
      });
      if (input.signal.aborted) throw new Error('Command aborted.');
      if (input.launchControl) {
        await waitForLaunchReady(input.launchControl.readyFile);
        if (input.signal.aborted) throw new Error('Command aborted.');
        fs.writeFileSync(input.launchControl.continueFile, '', { mode: 0o600 });
      }
    } catch (err) {
      terminate();
      void completion.catch(() => undefined);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal.removeEventListener('abort', onAbort);
      fs.rmSync(configFilePath, { force: true });
      throw err;
    }
  }
  return completion;
}

function asyncCommandLaunchScript(): string {
  return [
    'set -eu',
    'mkdir -p "$GANTRY_ASYNC_LAUNCH_DIR"',
    'echo "$$" > "$GANTRY_ASYNC_PID_FILE"',
    '(ps -o pgid= -p "$$" | tr -d " " > "$GANTRY_ASYNC_PGID_FILE") 2>/dev/null || echo "$$" > "$GANTRY_ASYNC_PGID_FILE"',
    ': > "$GANTRY_ASYNC_READY_FILE"',
    'while [ ! -f "$GANTRY_ASYNC_CONTINUE_FILE" ]; do sleep 0.05; done',
    'exec /bin/sh -c "$GANTRY_ASYNC_COMMAND_SCRIPT"',
  ].join('\n');
}

async function waitForLaunchReady(readyFile: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(readyFile)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Async command did not reach its launch barrier.');
}

function readProcessStartId(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function buildAsyncCommandEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ASYNC_COMMAND_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

function taskScope(context: TaskContext): {
  appId: string;
  agentId: string;
  conversationId: string;
  threadId?: string | null;
  sandboxPolicy: AsyncCommandSandboxPolicy;
} | null {
  const conversationId = validateSameConversation(context);
  if (!conversationId) return null;
  const sandboxPolicy = readAsyncCommandSandboxPolicy({
    sourceAgentFolder: context.sourceAgentFolder,
    runHandle: context.data.runHandle,
  });
  if (!sandboxPolicy) return null;
  const appId = toTrimmedString(context.data.appId, { maxLen: 120 });
  const agentId = toTrimmedString(context.data.agentId, { maxLen: 120 });
  const expectedAgentId = memoryAgentIdForWorkspaceFolder(
    context.sourceAgentFolder,
  );
  if (!appId || !agentId || agentId !== expectedAgentId) return null;
  if (sandboxPolicy.appId !== appId) return null;
  if (sandboxPolicy.agentId && sandboxPolicy.agentId !== agentId) return null;
  if (sandboxPolicy.conversationId !== conversationId) return null;
  if (
    sandboxPolicy.threadId !== undefined &&
    sandboxPolicy.threadId !== null &&
    sandboxPolicy.threadId !==
      (context.data.authThreadId || context.data.threadId)
  ) {
    return null;
  }
  if (sandboxPolicy.runId && sandboxPolicy.runId !== context.data.runId) {
    return null;
  }
  if (sandboxPolicy.jobId && sandboxPolicy.jobId !== context.data.jobId) {
    return null;
  }
  return {
    appId,
    agentId,
    conversationId,
    threadId: context.data.authThreadId || context.data.threadId || null,
    sandboxPolicy,
  };
}

async function configuredAllowedTools(
  context: TaskContext,
  scope: { appId: string; agentId: string },
): Promise<string[]> {
  const durableRules =
    (await resolveConfiguredAllowedTools({
      repository: context.deps.getToolRepository?.(),
      skillRepository: context.deps.getSkillRepository?.(),
      appId: scope.appId,
      agentId: scope.agentId,
    })) ?? [];
  const liveRules = readLiveToolRules({
    ipcDir: context.ipcBaseDir
      ? path.join(context.ipcBaseDir, context.sourceAgentFolder)
      : undefined,
    runHandle: context.data.runHandle,
  });
  return [...new Set([...durableRules, ...liveRules])];
}

const todoUpdateHandler: TaskHandler = async (context) => {
  const { accept, reject } = responder(context);
  const conversationId = validateSameConversation(context);
  if (!conversationId) {
    reject(
      'todo_update must target the originating conversation.',
      'forbidden',
    );
    return;
  }
  const payload = context.data.payload ?? {};
  const items = normalizeTodoItems(payload.items);
  if (!items) {
    reject(
      'todo_update requires 1-50 unique items with id, title, and status.',
      'invalid_request',
    );
    return;
  }
  const summary = toTrimmedString(payload.summary, { maxLen: 500 }) || null;
  const updatedAt = nowIso();
  const threadId = context.data.authThreadId || context.data.threadId || null;
  if (context.deps.renderAgentTodo) {
    await context.deps
      .renderAgentTodo(conversationId, {
        summary,
        items,
        threadId,
        updatedAt,
      })
      .catch((err) => {
        logger.debug(
          { err, conversationId },
          'todo_update channel render failed',
        );
      });
  }
  accept('Plan updated.');
};

const asyncRunCommandHandler: TaskHandler = async (context) => {
  const { acceptData, reject } = responder(context);
  const scope = taskScope(context);
  if (!scope) {
    reject(
      'async_run_command must target the originating app, agent, and conversation.',
      'forbidden',
    );
    return;
  }
  const service = taskService(context);
  if (!service) {
    reject('Async command runtime is unavailable.', 'unavailable');
    return;
  }
  const payload = context.data.payload ?? {};
  const command = toTrimmedString(payload.command, { maxLen: 20_000 });
  if (!command) {
    reject(
      'async_run_command requires a non-empty command.',
      'invalid_request',
    );
    return;
  }
  const { sandboxPolicy, ...scopedTaskOwner } = scope;
  const result = await service.start({
    ...scopedTaskOwner,
    parentRunId: context.data.jobId ? null : (context.data.runId ?? null),
    parentJobId: context.data.jobId ?? null,
    parentJobRunId: context.data.jobId ? (context.data.runId ?? null) : null,
    command,
    cwd: resolveWorkspaceFolderPath(context.sourceAgentFolder),
    protectedReadPaths: sandboxPolicy.protectedReadPaths,
    protectedWritePaths: sandboxPolicy.protectedWritePaths,
    allowedNetworkHosts: sandboxPolicy.allowedNetworkHosts,
    resourceLimits: sandboxPolicy.resourceLimits,
    memoryBlock: toTrimmedString(payload.memoryBlock, { maxLen: 100_000 }),
    allowedToolRules: await configuredAllowedTools(context, scopedTaskOwner),
    isScheduledJob: Boolean(context.data.jobId),
  });
  if (!result.ok) {
    reject(result.message, 'forbidden');
    return;
  }
  acceptData(`Started: ${result.task.summary || result.task.id}`, result.task);
};

const taskGetHandler: TaskHandler = async (context) => {
  const { acceptData, reject } = responder(context);
  const scope = taskScope(context);
  if (!scope) {
    reject(
      'task_get must target the originating app, agent, and conversation.',
      'forbidden',
    );
    return;
  }
  const service = taskService(context);
  if (!service) {
    reject('Async task runtime is unavailable.', 'unavailable');
    return;
  }
  const taskId = toTrimmedString(context.data.payload?.taskId, {
    maxLen: 160,
  });
  if (!taskId) {
    reject('task_get requires taskId.', 'invalid_request');
    return;
  }
  const { sandboxPolicy: _sandboxPolicy, ...scopedTaskOwner } = scope;
  const task = await service.getScoped({ ...scopedTaskOwner, taskId });
  if (!task) {
    reject('Task not found.', 'not_found');
    return;
  }
  acceptData('Task loaded.', task);
};

const taskListHandler: TaskHandler = async (context) => {
  const { acceptData, reject } = responder(context);
  const scope = taskScope(context);
  if (!scope) {
    reject(
      'task_list must target the originating app, agent, and conversation.',
      'forbidden',
    );
    return;
  }
  const service = taskService(context);
  if (!service) {
    reject('Async task runtime is unavailable.', 'unavailable');
    return;
  }
  const { sandboxPolicy: _sandboxPolicy, ...scopedTaskOwner } = scope;
  const tasks = await service.list({
    ...scopedTaskOwner,
    limit: 20,
  });
  acceptData(`Listed ${tasks.length} async task(s).`, { tasks });
};

const taskCancelHandler: TaskHandler = async (context) => {
  const { acceptData, reject } = responder(context);
  const scope = taskScope(context);
  if (!scope) {
    reject(
      'task_cancel must target the originating app, agent, and conversation.',
      'forbidden',
    );
    return;
  }
  const service = taskService(context);
  if (!service) {
    reject('Async task runtime is unavailable.', 'unavailable');
    return;
  }
  const taskId = toTrimmedString(context.data.payload?.taskId, {
    maxLen: 160,
  });
  if (!taskId) {
    reject('task_cancel requires taskId.', 'invalid_request');
    return;
  }
  const { sandboxPolicy: _sandboxPolicy, ...scopedTaskOwner } = scope;
  const result = await service.cancel({ ...scopedTaskOwner, taskId });
  if (!result.ok) {
    reject(
      result.message,
      result.message.includes('already finished')
        ? 'invalid_request'
        : 'not_found',
    );
    return;
  }
  acceptData(result.message, { taskId });
};

export const agentTaskLifecycleHandlers: Record<string, TaskHandler> = {
  async_run_command: asyncRunCommandHandler,
  task_cancel: taskCancelHandler,
  task_get: taskGetHandler,
  task_list: taskListHandler,
  todo_update: todoUpdateHandler,
};
