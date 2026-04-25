import { Job, RegisteredGroup } from '../core/types.js';

export interface SchedulerExecutionContext {
  group: RegisteredGroup;
  executionJid: string;
  stopAliasJids: string[];
  deliveryJids: string[];
  invalidLinkedSessionJids: string[];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function resolveExecutionContext(
  job: Job,
  groups: Record<string, RegisteredGroup>,
): SchedulerExecutionContext | null {
  const linkedSessions = unique(job.linked_sessions || []);
  const validLinkedSessions = linkedSessions.filter((jid) => groups[jid]);
  const invalidLinkedSessionJids = linkedSessions.filter((jid) => !groups[jid]);
  const byFolder = Object.entries(groups).find(
    ([, group]) => group.folder === job.group_scope,
  );

  if (byFolder) {
    const [fallbackJid, group] = byFolder;
    const deliveryJids = validLinkedSessions.length
      ? validLinkedSessions
      : [fallbackJid];
    return {
      group,
      executionJid: fallbackJid,
      stopAliasJids: unique([...deliveryJids, fallbackJid]),
      deliveryJids,
      invalidLinkedSessionJids,
    };
  }

  const executionJid = validLinkedSessions[0];
  if (!executionJid) return null;

  return {
    group: groups[executionJid],
    executionJid,
    stopAliasJids: validLinkedSessions,
    deliveryJids: validLinkedSessions,
    invalidLinkedSessionJids,
  };
}
