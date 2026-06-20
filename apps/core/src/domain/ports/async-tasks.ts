export type AsyncTaskKind = 'async_command' | 'delegated_agent';

export type AsyncTaskStatus =
  | 'queued'
  | 'running'
  | 'needs_attention'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface AsyncTaskReceipt {
  completed: string;
  used: string;
  changed: string;
  delegated: 'yes' | 'no';
  needsAttention: string;
}

export interface AsyncTaskRecord {
  id: string;
  appId: string;
  agentId: string;
  conversationId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  parentJobId?: string | null;
  parentJobRunId?: string | null;
  kind: AsyncTaskKind;
  status: AsyncTaskStatus;
  admissionClass: 'task';
  authoritySnapshotJson: Record<string, unknown>;
  privateCorrelationJson: Record<string, unknown>;
  leaseToken: string;
  fencingVersion: number;
  heartbeatAt?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  terminalAt?: string | null;
  summary?: string | null;
  outputSummary?: string | null;
  errorSummary?: string | null;
  receiptJson?: AsyncTaskReceipt | null;
}

export interface PublicAsyncTaskDto {
  id: string;
  kind: AsyncTaskKind;
  status: AsyncTaskStatus;
  summary?: string | null;
  outputSummary?: string | null;
  errorSummary?: string | null;
  receiptLines: string[];
  allowedActions: Array<'get' | 'list' | 'cancel'>;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string | null;
}

export interface AsyncTaskCreateInput {
  id: string;
  appId: string;
  agentId: string;
  conversationId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  parentJobId?: string | null;
  parentJobRunId?: string | null;
  kind: AsyncTaskKind;
  status: AsyncTaskStatus;
  admissionClass: 'task';
  authoritySnapshotJson: Record<string, unknown>;
  privateCorrelationJson?: Record<string, unknown>;
  leaseToken: string;
  fencingVersion: number;
  summary?: string | null;
  now: string;
}

export interface AsyncTaskListFilter {
  appId: string;
  agentId?: string;
  conversationId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  statuses?: AsyncTaskStatus[];
  limit?: number;
}

export interface AsyncTaskTransitionInput {
  taskId: string;
  leaseToken: string;
  fencingVersion: number;
  status: AsyncTaskStatus;
  now: string;
  heartbeatAt?: string | null;
  startedAt?: string | null;
  terminalAt?: string | null;
  privateCorrelationJson?: Record<string, unknown>;
  outputSummary?: string | null;
  errorSummary?: string | null;
  receiptJson?: AsyncTaskReceipt | null;
}

export interface AsyncTaskRepository {
  createTask(input: AsyncTaskCreateInput): Promise<AsyncTaskRecord>;
  createTaskWithAdmission?(
    input: AsyncTaskCreateInput,
    admission: {
      activeStatuses: AsyncTaskStatus[];
      maxActivePerApp: number;
      maxActivePerAgent: number;
    },
  ): Promise<
    | { ok: true; task: AsyncTaskRecord }
    | { ok: false; reason: 'app_capacity' | 'agent_capacity' }
  >;
  getTask(taskId: string): Promise<AsyncTaskRecord | null>;
  listTasks(filter: AsyncTaskListFilter): Promise<AsyncTaskRecord[]>;
  transitionTask(
    input: AsyncTaskTransitionInput,
  ): Promise<AsyncTaskRecord | null>;
}

const TERMINAL_STATUSES = new Set<AsyncTaskStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

export function isAsyncTaskTerminal(status: AsyncTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function toPublicAsyncTaskDto(
  task: AsyncTaskRecord,
): PublicAsyncTaskDto {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    summary: task.summary,
    outputSummary: task.outputSummary,
    errorSummary: task.errorSummary,
    receiptLines: receiptLines(task.receiptJson),
    allowedActions: isAsyncTaskTerminal(task.status)
      ? ['get', 'list']
      : ['get', 'list', 'cancel'],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    terminalAt: task.terminalAt,
  };
}

function receiptLines(receipt: AsyncTaskReceipt | null | undefined): string[] {
  if (!receipt) return [];
  return [
    `Completed: ${receipt.completed}`,
    `Used: ${receipt.used}`,
    `Changed: ${receipt.changed}`,
    `Delegated: ${receipt.delegated}`,
    `Needs attention: ${receipt.needsAttention}`,
  ];
}
