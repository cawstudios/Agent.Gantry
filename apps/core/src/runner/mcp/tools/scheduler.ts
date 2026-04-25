import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'path';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import {
  nowIso,
  nowMs,
  parseIso,
  sleep,
} from '../../../infrastructure/time/datetime.js';
import { IPC_DIR, TASKS_DIR } from '../context.js';
import { formatTaskFailureLines } from '../formatting.js';
import {
  readJsonArraySnapshot,
  waitForTaskResponse,
  writeIpcFile,
} from '../ipc.js';
import {
  filterSchedulerEvents,
  normalizeExecutionMode,
  resolveSchedulerThreadArg,
} from '../scheduler-utils.js';

export function registerSchedulerTools(server: McpServer): void {
  server.tool(
    'scheduler_upsert_job',
    'Create or update a scheduler job. Idempotent by job ID.',
    {
      job_id: z.string().optional(),
      name: z.string(),
      prompt: z.string(),
      model: z.string().optional(),
      schedule_type: z.enum(['cron', 'interval', 'once']),
      schedule_value: z.string().default(''),
      linked_sessions: z.array(z.string()).optional(),
      deliver_to: z.array(z.string()).optional(),
      thread_id: z.string().optional(),
      silent: z.boolean().optional(),
      cleanup_after_ms: z.number().optional(),
      group_scope: z.string().optional(),
      timeout_ms: z.number().optional(),
      max_retries: z.number().optional(),
      retry_backoff_ms: z.number().optional(),
      max_consecutive_failures: z.number().optional(),
      execution_mode: z.enum(['parallel', 'serialized']).optional(),
      serialize: z.boolean().optional(),
    },
    async (args) => {
      if (args.schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              { type: 'text' as const, text: 'Invalid cron expression.' },
            ],
            isError: true,
          };
        }
      }
      if (args.schedule_type === 'interval') {
        const ms = parseInt(args.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          return {
            content: [
              { type: 'text' as const, text: 'Invalid interval milliseconds.' },
            ],
            isError: true,
          };
        }
      }
      if (args.schedule_type === 'once') {
        const date = parseIso(args.schedule_value);
        if (!date) {
          return {
            content: [
              { type: 'text' as const, text: 'Invalid once timestamp.' },
            ],
            isError: true,
          };
        }
      }

      const schedulerThread = resolveSchedulerThreadArg(args.thread_id, true);
      if (schedulerThread.error) {
        return {
          content: [{ type: 'text' as const, text: schedulerThread.error }],
          isError: true,
        };
      }

      const taskId = `scheduler-upsert-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
      const data = {
        type: 'scheduler_upsert_job',
        taskId,
        jobId: args.job_id,
        name: args.name,
        prompt: args.prompt,
        model: args.model,
        scheduleType: args.schedule_type,
        scheduleValue: args.schedule_value,
        linkedSessions: args.linked_sessions,
        deliverTo: args.deliver_to,
        ...(schedulerThread.threadId !== undefined
          ? { threadId: schedulerThread.threadId }
          : {}),
        silent: args.silent,
        cleanupAfterMs: args.cleanup_after_ms,
        groupScope: args.group_scope,
        timeoutMs: args.timeout_ms,
        maxRetries: args.max_retries,
        retryBackoffMs: args.retry_backoff_ms,
        maxConsecutiveFailures: args.max_consecutive_failures,
        executionMode: normalizeExecutionMode(
          args.execution_mode,
          args.serialize,
        ),
        serialize: args.serialize,
        createdBy: 'agent',
        timestamp: nowIso(),
      };
      writeIpcFile(TASKS_DIR, data);
      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduler upsert timed out waiting for host confirmation.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Scheduler upsert was rejected.',
              ).join('\n'),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Scheduler job upsert completed.',
          },
        ],
      };
    },
  );

  server.tool(
    'scheduler_get_job',
    'Get one scheduler job by ID from host snapshots.',
    { job_id: z.string() },
    async (args) => {
      const jobs = readJsonArraySnapshot(
        path.join(IPC_DIR, 'current_jobs.json'),
      );
      const job =
        jobs.find(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            'id' in item &&
            (item as { id?: string }).id === args.job_id,
        ) || null;
      return {
        content: [
          {
            type: 'text' as const,
            text: job ? JSON.stringify(job, null, 2) : 'Job not found.',
          },
        ],
      };
    },
  );

  server.tool(
    'scheduler_list_jobs',
    'List scheduler jobs from host snapshots.',
    {
      statuses: z.array(z.string()).optional(),
      group_scope: z.string().optional(),
    },
    async (args) => {
      const jobs = readJsonArraySnapshot(
        path.join(IPC_DIR, 'current_jobs.json'),
      );
      const filtered = jobs.filter((item) => {
        if (typeof item !== 'object' || item === null) return false;
        const row = item as { status?: string; group_scope?: string };
        if (args.statuses && args.statuses.length > 0) {
          if (!row.status || !args.statuses.includes(row.status)) return false;
        }
        if (args.group_scope && row.group_scope !== args.group_scope)
          return false;
        return true;
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(filtered, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'scheduler_update_job',
    'Update mutable fields on a scheduler job.',
    {
      job_id: z.string(),
      name: z.string().optional(),
      prompt: z.string().optional(),
      model: z.string().optional(),
      schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
      schedule_value: z.string().optional(),
      linked_sessions: z.array(z.string()).optional(),
      deliver_to: z.array(z.string()).optional(),
      thread_id: z.string().optional(),
      silent: z.boolean().optional(),
      cleanup_after_ms: z.number().optional(),
      group_scope: z.string().optional(),
      timeout_ms: z.number().optional(),
      max_retries: z.number().optional(),
      retry_backoff_ms: z.number().optional(),
      max_consecutive_failures: z.number().optional(),
      execution_mode: z.enum(['parallel', 'serialized']).optional(),
      serialize: z.boolean().optional(),
    },
    async (args) => {
      const executionMode =
        args.execution_mode !== undefined || args.serialize !== undefined
          ? normalizeExecutionMode(args.execution_mode, args.serialize)
          : undefined;
      const schedulerThread = resolveSchedulerThreadArg(args.thread_id, false);
      if (schedulerThread.error) {
        return {
          content: [{ type: 'text' as const, text: schedulerThread.error }],
          isError: true,
        };
      }
      const taskId = `scheduler-update-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'scheduler_update_job',
        taskId,
        jobId: args.job_id,
        name: args.name,
        prompt: args.prompt,
        model: args.model,
        scheduleType: args.schedule_type,
        scheduleValue: args.schedule_value,
        linkedSessions: args.linked_sessions,
        deliverTo: args.deliver_to,
        ...(schedulerThread.threadId !== undefined
          ? { threadId: schedulerThread.threadId }
          : {}),
        silent: args.silent,
        cleanupAfterMs: args.cleanup_after_ms,
        groupScope: args.group_scope,
        timeoutMs: args.timeout_ms,
        maxRetries: args.max_retries,
        retryBackoffMs: args.retry_backoff_ms,
        maxConsecutiveFailures: args.max_consecutive_failures,
        executionMode,
        serialize: args.serialize,
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduler update timed out waiting for host confirmation.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Scheduler update was rejected.',
              ).join('\n'),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Scheduler job update completed.',
          },
        ],
      };
    },
  );

  server.tool(
    'scheduler_delete_job',
    'Delete a scheduler job.',
    { job_id: z.string() },
    async (args) => {
      const taskId = `scheduler-delete-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'scheduler_delete_job',
        taskId,
        jobId: args.job_id,
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduler delete timed out waiting for host confirmation.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Scheduler delete was rejected.',
              ).join('\n'),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Scheduler job delete completed.',
          },
        ],
      };
    },
  );

  server.tool(
    'scheduler_pause_job',
    'Pause a scheduler job.',
    { job_id: z.string() },
    async (args) => {
      const taskId = `scheduler-pause-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'scheduler_pause_job',
        taskId,
        jobId: args.job_id,
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduler pause timed out waiting for host confirmation.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Scheduler pause was rejected.',
              ).join('\n'),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Scheduler job pause completed.',
          },
        ],
      };
    },
  );

  server.tool(
    'scheduler_resume_job',
    'Resume a paused scheduler job.',
    { job_id: z.string() },
    async (args) => {
      const taskId = `scheduler-resume-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'scheduler_resume_job',
        taskId,
        jobId: args.job_id,
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduler resume timed out waiting for host confirmation.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Scheduler resume was rejected.',
              ).join('\n'),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Scheduler job resume completed.',
          },
        ],
      };
    },
  );

  server.tool(
    'scheduler_list_runs',
    'List job runs from host snapshots.',
    {
      job_id: z.string().optional(),
      limit: z.number().optional(),
    },
    async (args) => {
      const runs = readJsonArraySnapshot(
        path.join(IPC_DIR, 'current_job_runs.json'),
      );
      const filtered = runs
        .filter((item) => {
          if (typeof item !== 'object' || item === null) return false;
          if (!args.job_id) return true;
          return (item as { job_id?: string }).job_id === args.job_id;
        })
        .slice(0, args.limit ?? 50);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(filtered, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'scheduler_list_events',
    'List scheduler lifecycle events from host snapshots.',
    {
      job_id: z.string().optional(),
      run_id: z.string().optional(),
      event_type: z.string().optional(),
      since_id: z.number().optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
    },
    async (args) => {
      const events = readJsonArraySnapshot(
        path.join(IPC_DIR, 'current_job_events.json'),
      );
      const filtered = filterSchedulerEvents(events, args).slice(
        0,
        args.limit ?? 100,
      );
      writeIpcFile(TASKS_DIR, {
        type: 'scheduler_list_events',
        jobId: args.job_id,
        runId: args.run_id,
        eventType: args.event_type,
        sinceId: args.since_id,
        limit: args.limit,
        timestamp: nowIso(),
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(filtered, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'scheduler_wait_for_events',
    'Wait for scheduler lifecycle events to arrive in host snapshots.',
    {
      job_id: z.string().optional(),
      run_id: z.string().optional(),
      event_type: z.string().optional(),
      since_id: z.number().optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
      timeout_ms: z.number().optional(),
    },
    async (args) => {
      const timeoutMs = Math.max(
        1_000,
        Math.min(args.timeout_ms ?? 30_000, 120_000),
      );
      const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
      const deadline = nowMs() + timeoutMs;
      while (nowMs() < deadline) {
        const events = readJsonArraySnapshot(
          path.join(IPC_DIR, 'current_job_events.json'),
        );
        const filtered = filterSchedulerEvents(events, args).slice(0, limit);
        if (filtered.length > 0) {
          writeIpcFile(TASKS_DIR, {
            type: 'scheduler_wait_for_events',
            jobId: args.job_id,
            runId: args.run_id,
            eventType: args.event_type,
            sinceId: args.since_id,
            limit,
            timestamp: nowIso(),
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(filtered, null, 2),
              },
            ],
          };
        }
        await sleep(250);
      }
      return {
        content: [{ type: 'text' as const, text: '[]' }],
      };
    },
  );

  server.tool(
    'scheduler_get_dead_letter',
    'List dead-lettered job runs from host snapshots.',
    { limit: z.number().optional() },
    async (args) => {
      const runs = readJsonArraySnapshot(
        path.join(IPC_DIR, 'current_job_runs.json'),
      )
        .filter(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { status?: string }).status === 'dead_lettered',
        )
        .slice(0, args.limit ?? 50);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(runs, null, 2) },
        ],
      };
    },
  );
}
