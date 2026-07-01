import type { GroupAgentRunResult } from './group-agent-runner.js';

export type ActiveTurnUiCleanup = {
  token: symbol;
  cancel: () => void | Promise<void>;
};

export type GroupProcessOptions = {
  queued?: boolean;
  memoryContext?: {
    userId?: string;
    source?: 'message' | 'command';
    threadId?: string | null;
    recallQuery?: string;
  };
  existingRunId?: string;
  existingRunLeaseToken?: string;
  existingRunLeaseWorkerInstanceId?: string;
  existingRunLeaseFencingVersion?: number;
  finalRetry?: boolean;
  onRunResult?: (result: GroupAgentRunResult) => void;
  onFirstProgress?: (input: {
    jid: string;
    messageRef: string;
  }) => Promise<void> | void;
  onLiveStopActionToken?: (token: string) => Promise<void> | void;
};
