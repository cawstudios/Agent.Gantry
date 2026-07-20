import {
  buildTaskLifecycleRuntimeEvent,
  type TaskLifecycleEventInput,
  type TaskLifecycleUsageInput,
} from '../../../../runner/task-lifecycle-events.js';
import type {
  AgentRunnerInput,
  AgentRunnerRuntimeEventOutput,
} from './types.js';

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.trim().length > 0
    ? field
    : undefined;
}

function finiteNumberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field)
    ? field
    : undefined;
}

function taskUsagePayload(value: unknown): TaskLifecycleUsageInput | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const out: TaskLifecycleUsageInput = {};
  const totalTokens = finiteNumberField(usage, 'total_tokens');
  const toolUses = finiteNumberField(usage, 'tool_uses');
  const durationMs = finiteNumberField(usage, 'duration_ms');
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  if (toolUses !== undefined) out.toolUses = toolUses;
  if (durationMs !== undefined) out.durationMs = durationMs;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function taskRuntimeEvent(
  agentInput: AgentRunnerInput,
  message: Record<string, unknown>,
): AgentRunnerRuntimeEventOutput | null {
  const taskId = stringField(message, 'task_id');
  if (!taskId) return null;
  const toolUseId = stringField(message, 'tool_use_id');
  const context = {
    appId: agentInput.appId,
    agentId: agentInput.agentId,
    runId: agentInput.runId,
    jobId: agentInput.jobId,
    conversationId: agentInput.chatJid,
    threadId: agentInput.threadId,
    actor: 'sdk',
  };
  let input: TaskLifecycleEventInput | null = null;

  if (message.subtype === 'task_started') {
    input = {
      kind: 'started',
      taskId,
      toolUseId,
      description: stringField(message, 'description'),
      subagentType: stringField(message, 'subagent_type'),
      taskType: stringField(message, 'task_type'),
      workflowName: stringField(message, 'workflow_name'),
      skipTranscript: message.skip_transcript === true,
    };
  }

  if (message.subtype === 'task_progress') {
    input = {
      kind: 'progress',
      taskId,
      toolUseId,
      description: stringField(message, 'description'),
      subagentType: stringField(message, 'subagent_type'),
      lastToolName: stringField(message, 'last_tool_name'),
      summary: stringField(message, 'summary'),
      usage: taskUsagePayload(message.usage),
    };
  }

  if (message.subtype === 'task_updated') {
    const patch =
      message.patch && typeof message.patch === 'object'
        ? (message.patch as Record<string, unknown>)
        : {};
    input = {
      kind: 'updated',
      taskId,
      toolUseId,
      patch: {
        status: stringField(patch, 'status'),
        description: stringField(patch, 'description'),
        endTime: finiteNumberField(patch, 'end_time'),
        totalPausedMs: finiteNumberField(patch, 'total_paused_ms'),
        isBackgrounded:
          typeof patch.is_backgrounded === 'boolean'
            ? patch.is_backgrounded
            : undefined,
        hasError: typeof patch.error === 'string' && patch.error.length > 0,
      },
    };
  }

  if (message.subtype === 'task_notification') {
    input = {
      kind: 'notification',
      taskId,
      toolUseId,
      status: stringField(message, 'status'),
      summary: stringField(message, 'summary'),
      skipTranscript: message.skip_transcript === true,
      usage: taskUsagePayload(message.usage),
    };
  }

  return input ? buildTaskLifecycleRuntimeEvent(context, input) : null;
}
