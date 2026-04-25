import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { DATA_DIR } from '../config/index.js';
import { nowIso } from '../infrastructure/time/datetime.js';
import { writeFileAtomic } from '../infrastructure/filesystem/paths.js';
import { signIpcResponsePayload } from '../infrastructure/ipc/response-signing.js';
import { JobExecutionMode, RegisteredGroup } from '../domain/types.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import {
  getServiceStatus,
  startService,
  stopService,
} from '../infrastructure/service/manager.js';
import { toTrimmedString } from '../shared/object.js';
import { getIpcResponseSigningPrivateKey } from '../runtime/ipc-auth.js';

const TASK_IPC_RESPONSE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export { toTrimmedString };

export function normalizeIpcExecutionMode(
  executionMode: unknown,
  serialize: unknown,
  fallback: JobExecutionMode = 'parallel',
): JobExecutionMode {
  if (executionMode === 'serialized') return 'serialized';
  if (executionMode === 'parallel') return 'parallel';
  if (typeof serialize === 'boolean') {
    return serialize ? 'serialized' : 'parallel';
  }
  return fallback;
}

export function jobBelongsToSourceGroup(
  job: { group_scope: string; linked_sessions: string[] },
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  if (job.group_scope !== sourceGroup) return false;
  return job.linked_sessions.every((jid) => {
    const group = registeredGroups[jid];
    return !!group && group.folder === sourceGroup;
  });
}

export function jobBelongsToAuthThread(
  job: { thread_id: string | null },
  authThreadId?: string,
): boolean {
  if (!authThreadId) return (job.thread_id || null) === null;
  return (job.thread_id || null) === authThreadId;
}

export function generateJobId(params: {
  name: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  groupScope: string;
}): string {
  const base = JSON.stringify({
    name: params.name,
    prompt: params.prompt,
    scheduleType: params.scheduleType,
    scheduleValue: params.scheduleValue,
    groupScope: params.groupScope,
  });
  const hash = createHash('sha256').update(base).digest('hex').slice(0, 12);
  const slug = params.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `job-${slug || 'scheduled'}-${hash}`;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

export function writeTaskIpcResponse(
  sourceGroup: string,
  taskId: string | undefined,
  payload: {
    ok: boolean;
    code?: string;
    message?: string;
    error?: string;
    details?: string[];
  },
  authThreadId?: string,
): void {
  if (!taskId || !TASK_IPC_RESPONSE_ID_PATTERN.test(taskId)) return;
  if (!isValidGroupFolder(sourceGroup)) return;
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'task-responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `task-${taskId}.json`);
  const responsePayload = {
    taskId,
    ...payload,
    timestamp: nowIso(),
  };
  const privateKeyPem = getIpcResponseSigningPrivateKey(
    sourceGroup,
    authThreadId,
  );
  const signature = signIpcResponsePayload(privateKeyPem, responsePayload);
  writeJsonAtomic(
    responsePath,
    signature ? { ...responsePayload, signature } : responsePayload,
  );
}

export function createTaskResponder(
  sourceGroup: string,
  taskIdRaw: unknown,
  authThreadId?: string,
): {
  accept: (message: string, code?: string, details?: string[]) => void;
  reject: (error: string, code?: string, details?: string[]) => void;
} {
  const taskId = toTrimmedString(taskIdRaw, { maxLen: 128 });
  return {
    accept: (message: string, code?: string, details?: string[]) => {
      writeTaskIpcResponse(
        sourceGroup,
        taskId,
        {
          ok: true,
          ...(code ? { code } : {}),
          message,
          ...(details && details.length > 0 ? { details } : {}),
        },
        authThreadId,
      );
    },
    reject: (error: string, code?: string, details?: string[]) => {
      writeTaskIpcResponse(
        sourceGroup,
        taskId,
        {
          ok: false,
          ...(code ? { code } : {}),
          error,
          ...(details && details.length > 0 ? { details } : {}),
        },
        authThreadId,
      );
    },
  };
}

export function restartServiceForRuntimeHome(runtimeHome: string): {
  ok: boolean;
  message: string;
} {
  try {
    const serviceStatus = getServiceStatus(runtimeHome);
    if (serviceStatus.kind === 'launchd') {
      const startOutcome = startService(runtimeHome);
      if (!startOutcome.ok) {
        return { ok: false, message: startOutcome.message };
      }
      return {
        ok: true,
        message: `${startOutcome.message} (restart completed).`,
      };
    }

    const stopOutcome = stopService(runtimeHome);
    if (!stopOutcome.ok) {
      return { ok: false, message: stopOutcome.message };
    }
    const startOutcome = startService(runtimeHome);
    if (!startOutcome.ok) {
      return {
        ok: false,
        message: `Restart failed after stop: ${startOutcome.message}`,
      };
    }
    return {
      ok: true,
      message: `${startOutcome.message} (restart completed).`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
