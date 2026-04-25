import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from '../platform/group-folder.js';
import {
  AvailableGroup,
  JobEventSnapshotRow,
  JobRunSnapshotRow,
  JobSnapshotRow,
} from './agent-spawn-types.js';

const MAX_SNAPSHOT_DIGEST_CACHE_ENTRIES = 512;
const snapshotContentDigestCache = new Map<string, string>();

function hashSnapshotContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function rememberSnapshotDigest(file: string, digest: string): void {
  snapshotContentDigestCache.delete(file);
  snapshotContentDigestCache.set(file, digest);
  while (snapshotContentDigestCache.size > MAX_SNAPSHOT_DIGEST_CACHE_ENTRIES) {
    const oldest = snapshotContentDigestCache.keys().next().value;
    if (!oldest) break;
    snapshotContentDigestCache.delete(oldest);
  }
}

async function writeSnapshotJson(file: string, value: unknown): Promise<void> {
  const content = JSON.stringify(value, null, 2);
  const digest = hashSnapshotContent(content);
  if (snapshotContentDigestCache.get(file) === digest) return;

  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });

  try {
    const current = await fs.promises.readFile(file, 'utf-8');
    if (current === content) {
      rememberSnapshotDigest(file, digest);
      return;
    }
  } catch (err) {
    const code =
      typeof err === 'object' && err && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (code !== 'ENOENT') throw err;
  }

  const tempFile = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.promises.writeFile(tempFile, content, 'utf-8');
    await fs.promises.rename(tempFile, file);
    rememberSnapshotDigest(file, digest);
  } catch (err) {
    await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    throw err;
  }
}

export function clearSnapshotWriteCacheForTests(): void {
  snapshotContentDigestCache.clear();
}

export async function writeJobsSnapshot(
  groupFolder: string,
  isMain: boolean,
  jobs: JobSnapshotRow[],
): Promise<void> {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  const filtered = isMain
    ? jobs
    : jobs.filter((job) => job.group_scope === groupFolder);

  const file = path.join(groupIpcDir, 'current_jobs.json');
  await writeSnapshotJson(file, filtered);
}

export async function writeJobRunsSnapshot(
  groupFolder: string,
  isMain: boolean,
  runs: JobRunSnapshotRow[],
  jobs: JobSnapshotRow[],
): Promise<void> {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);

  let allowedJobIds: Set<string> | null = null;
  if (!isMain) {
    allowedJobIds = new Set(
      jobs
        .filter((job) => job.group_scope === groupFolder)
        .map((job) => job.id),
    );
  }

  const filtered =
    isMain || !allowedJobIds
      ? runs
      : runs.filter((run) => allowedJobIds.has(run.job_id));

  const file = path.join(groupIpcDir, 'current_job_runs.json');
  await writeSnapshotJson(file, filtered);
}

export async function writeJobEventsSnapshot(
  groupFolder: string,
  isMain: boolean,
  events: JobEventSnapshotRow[],
  jobs: JobSnapshotRow[],
): Promise<void> {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);

  let allowedJobIds: Set<string> | null = null;
  if (!isMain) {
    allowedJobIds = new Set(
      jobs
        .filter((job) => job.group_scope === groupFolder)
        .map((job) => job.id),
    );
  }

  const filtered =
    isMain || !allowedJobIds
      ? events
      : events.filter((event) => allowedJobIds.has(event.job_id));

  const file = path.join(groupIpcDir, 'current_job_events.json');
  await writeSnapshotJson(file, filtered);
}

export async function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): Promise<void> {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  const visibleGroups = isMain ? groups : [];
  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  await writeSnapshotJson(groupsFile, {
    groups: visibleGroups,
    lastSync: new Date().toISOString(),
  });
}
