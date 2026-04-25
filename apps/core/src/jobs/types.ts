import type { ChildProcess } from 'child_process';

import type {
  RegisteredGroup,
  StreamingChunkOptions,
} from '../domain/types.js';
import type { OpsRepository } from '../domain/repositories/ops-repo.js';
import type { GroupQueue } from '../runtime/group-queue.js';
import type { spawnAgent } from '../runtime/agent-spawn.js';
import type { SchedulerSendMessage } from './delivery.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions?: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
    stopAliasJids?: string[],
  ) => void;
  sendMessage: SchedulerSendMessage;
  sendStreamingChunk?: (
    jid: string,
    text: string,
    options?: StreamingChunkOptions,
  ) => Promise<boolean>;
  resetStreaming?: (jid: string) => void;
  onSchedulerChanged?: (jobId?: string) => void;
  runAgent?: typeof spawnAgent;
  opsRepository: OpsRepository;
}

export interface SchedulerDispatchPayload {
  jobId: string;
  triggerId?: string | null;
  scheduledFor?: string | null;
}
