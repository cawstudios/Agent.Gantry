import type { JobExecutionMode } from '../domain/types.js';

const MAX_PARALLEL_JOBS_PER_GROUP_SCOPE = 2;
const activeParallelRunsByGroupScope = new Map<string, number>();
const activeSerializedRunsByGroupScope = new Map<string, number>();

export function canScheduleParallelRunForGroup(
  groupScope: string,
  queuedParallelThisTick: Map<string, number>,
  queuedSerializedThisTick: Map<string, number>,
): boolean {
  const active = activeParallelRunsByGroupScope.get(groupScope) || 0;
  const queued = queuedParallelThisTick.get(groupScope) || 0;
  const activeSerialized =
    activeSerializedRunsByGroupScope.get(groupScope) || 0;
  const queuedSerialized = queuedSerializedThisTick.get(groupScope) || 0;
  if (activeSerialized + queuedSerialized > 0) return false;
  return active + queued < MAX_PARALLEL_JOBS_PER_GROUP_SCOPE;
}

export function reserveParallelRunForTick(
  groupScope: string,
  queuedParallelThisTick: Map<string, number>,
): void {
  const current = queuedParallelThisTick.get(groupScope) || 0;
  queuedParallelThisTick.set(groupScope, current + 1);
}

function acquireParallelRunSlot(groupScope: string): () => void {
  const current = activeParallelRunsByGroupScope.get(groupScope) || 0;
  activeParallelRunsByGroupScope.set(groupScope, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const active = activeParallelRunsByGroupScope.get(groupScope) || 0;
    if (active <= 1) {
      activeParallelRunsByGroupScope.delete(groupScope);
      return;
    }
    activeParallelRunsByGroupScope.set(groupScope, active - 1);
  };
}

export function canScheduleSerializedRunForGroup(
  groupScope: string,
  queuedParallelThisTick: Map<string, number>,
  queuedSerializedThisTick: Map<string, number>,
): boolean {
  const activeParallel = activeParallelRunsByGroupScope.get(groupScope) || 0;
  const queuedParallel = queuedParallelThisTick.get(groupScope) || 0;
  if (activeParallel + queuedParallel > 0) return false;
  const activeSerialized =
    activeSerializedRunsByGroupScope.get(groupScope) || 0;
  const queuedSerialized = queuedSerializedThisTick.get(groupScope) || 0;
  return activeSerialized + queuedSerialized < 1;
}

export function reserveSerializedRunForTick(
  groupScope: string,
  queuedSerializedThisTick: Map<string, number>,
): void {
  const current = queuedSerializedThisTick.get(groupScope) || 0;
  queuedSerializedThisTick.set(groupScope, current + 1);
}

function acquireSerializedRunSlot(groupScope: string): () => void {
  const current = activeSerializedRunsByGroupScope.get(groupScope) || 0;
  activeSerializedRunsByGroupScope.set(groupScope, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const active = activeSerializedRunsByGroupScope.get(groupScope) || 0;
    if (active <= 1) {
      activeSerializedRunsByGroupScope.delete(groupScope);
      return;
    }
    activeSerializedRunsByGroupScope.set(groupScope, active - 1);
  };
}

export function acquireRunSlot(
  groupScope: string,
  executionMode: JobExecutionMode,
): () => void {
  return executionMode === 'parallel'
    ? acquireParallelRunSlot(groupScope)
    : acquireSerializedRunSlot(groupScope);
}

export function resetSchedulerRunSlots(): void {
  activeParallelRunsByGroupScope.clear();
  activeSerializedRunsByGroupScope.clear();
}
