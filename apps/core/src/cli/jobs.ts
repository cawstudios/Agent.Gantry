import * as p from '@clack/prompts';

import { controlApiRequest } from './control-api.js';

interface JobRecord {
  jobId: string;
  name: string;
  kind: string;
  status: string;
  groupScope: string;
  threadId: string | null;
  nextRun: string | null;
  lastRun: string | null;
  modelAlias: string | null;
  prompt: string;
}

export async function runJobsCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [action, maybeJobId, ...rest] = args;
  if (action === 'list') return listJobs(runtimeHome, [maybeJobId, ...rest]);
  if (action === 'show' && maybeJobId) return showJob(runtimeHome, maybeJobId);
  p.log.error('Usage: myclaw jobs list|show <job_id>');
  return 1;
}

async function listJobs(runtimeHome: string, args: string[]): Promise<number> {
  const params = new URLSearchParams();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    const next = args[index + 1];
    if (arg === '--agent' && next) {
      params.set('agentId', next);
      index += 1;
    } else if (arg === '--group' && next) {
      params.set('groupScope', next);
      index += 1;
    } else if (arg === '--conversation' && next) {
      params.set('conversationJid', next);
      index += 1;
    } else if (arg === '--kind' && next) {
      params.set('kind', next);
      index += 1;
    } else if (arg === '--status' && next) {
      params.append('status', next);
      index += 1;
    } else if (arg === '--limit' && next) {
      params.set('limit', next);
      index += 1;
    }
  }
  const response = (await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: `/v1/jobs${params.toString() ? `?${params}` : ''}`,
  })) as { jobs?: JobRecord[] };
  const jobs = response.jobs ?? [];
  if (jobs.length === 0) {
    p.note('No jobs found.', 'Jobs');
    return 0;
  }
  p.note(formatJobTable(jobs), 'Jobs');
  return 0;
}

async function showJob(runtimeHome: string, jobId: string): Promise<number> {
  const job = (await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: `/v1/jobs/${encodeURIComponent(jobId)}`,
  })) as Record<string, unknown>;
  p.note(JSON.stringify(job, null, 2), `Job ${jobId}`);
  return 0;
}

function formatJobTable(jobs: JobRecord[]): string {
  const rows = jobs.map((job) => [
    job.jobId,
    job.kind,
    job.status,
    job.groupScope,
    job.threadId ?? '',
    job.nextRun ?? '',
    job.name,
  ]);
  const headers = [
    'ID',
    'Kind',
    'Status',
    'Group',
    'Thread',
    'Next run',
    'Name',
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  return [headers, ...rows]
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
