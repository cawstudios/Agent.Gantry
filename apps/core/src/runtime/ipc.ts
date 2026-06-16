import fs from 'node:fs';
import path from 'node:path';

import { isValidGroupFolder } from '../platform/group-folder.js';
import type { ConversationRoute as RuntimeGroupRecord } from '../domain/types.js';
import { clearConsumedIpcRequestIds } from './ipc-auth-validation.js';
import { clearIpcRateLimitState } from './ipc-rate-limit.js';
import { clearIpcResponders } from './ipc-response-router.js';
import { clearInteractionInFlight } from './ipc-interaction-inflight.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { parsePermissionIpcRequest } from './ipc-parsing.js';

export type { IpcDeps } from './ipc-domain-types.js';
export { processTaskIpc } from '../jobs/ipc-handler.js';
export { validateIpcAuthRequest } from './ipc-auth-validation.js';

export function resolveIpcFoldersFromGroups(
  groupRegistry: Record<string, RuntimeGroupRecord>,
): string[] {
  return Array.from(
    new Set(
      Object.values(groupRegistry)
        .map((group) => group.folder)
        .filter((folder): folder is string => isValidGroupFolder(folder)),
    ),
  );
}

export function resolveIpcTargetJidForSourceGroup(
  groupRegistry: Record<string, RuntimeGroupRecord>,
  sourceAgentFolder: string,
): string | undefined {
  for (const [jid, group] of Object.entries(groupRegistry)) {
    if (group.folder === sourceAgentFolder) return jid;
  }
  return undefined;
}

export function isTrustedRegisteredIpcFolder(
  ipcBaseDir: string,
  folder: string,
): boolean {
  const groupDir = path.join(ipcBaseDir, folder);
  if (!fs.existsSync(groupDir)) return true;
  try {
    const st = fs.lstatSync(groupDir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export async function validatePermissionIpcJobExecutionTarget(input: {
  request: ReturnType<typeof parsePermissionIpcRequest>;
  sourceAgentFolder: string;
  deps: IpcDeps;
}): Promise<void> {
  const { request, sourceAgentFolder, deps } = input;
  if (!request.jobId) return;

  if (!request.targetJid) {
    throw new Error('Scheduled job permission IPC requires targetJid');
  }
  if (!request.runId) {
    throw new Error('Scheduled job permission IPC requires runId');
  }

  const job = await deps.opsRepository.getJobById(request.jobId);
  if (!job) {
    throw new Error('Scheduled job permission IPC references unknown job');
  }
  const execution = job.execution_context;
  if (!execution?.conversationJid) {
    throw new Error(
      'Scheduled job permission IPC requires canonical execution_context',
    );
  }
  const executionGroupScope =
    normalizeNullableString(execution.groupScope) ??
    normalizeNullableString(job.group_scope);
  if (executionGroupScope && executionGroupScope !== sourceAgentFolder) {
    throw new Error(
      'Scheduled job permission IPC source does not match job execution context',
    );
  }
  if (execution.conversationJid !== request.targetJid) {
    throw new Error(
      'Scheduled job permission IPC target does not match job execution context',
    );
  }
  if (
    normalizeNullableString(execution.threadId) !==
    normalizeNullableString(request.threadId)
  ) {
    throw new Error(
      'Scheduled job permission IPC thread does not match job execution context',
    );
  }

  const run = await deps.opsRepository.getJobRunById(request.runId);
  if (!run || run.job_id !== request.jobId) {
    throw new Error('Scheduled job permission IPC run does not match job');
  }
}

export function resetIpcRuntimeState(): void {
  clearConsumedIpcRequestIds();
  clearIpcRateLimitState();
  clearIpcResponders();
  clearInteractionInFlight();
}
