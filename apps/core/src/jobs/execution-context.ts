import type { Job, RegisteredGroup } from '../domain/types.js';

export function resolveExecutionContext(
  job: Job,
  groups: Record<string, RegisteredGroup>,
): {
  group: RegisteredGroup;
  executionJid: string;
  stopAliasJids: string[];
} | null {
  const byFolder = Object.entries(groups).find(
    ([, group]) => group.folder === job.group_scope,
  );
  if (byFolder) {
    const stopAliasJids = Array.from(
      new Set([...(job.linked_sessions || []), byFolder[0]]),
    );
    return {
      group: byFolder[1],
      executionJid: stopAliasJids[0] || byFolder[0],
      stopAliasJids,
    };
  }

  for (const linked of job.linked_sessions) {
    const group = groups[linked];
    if (group) {
      const stopAliasJids = Array.from(
        new Set([...(job.linked_sessions || []), linked]),
      );
      return { group, executionJid: linked, stopAliasJids };
    }
  }
  return null;
}

export function parseTriggerRequesterSessionId(
  requestedBy: string,
): string | null {
  try {
    const parsed = JSON.parse(requestedBy) as Record<string, unknown>;
    if (
      parsed.kind === 'sdk' &&
      typeof parsed.sessionId === 'string' &&
      parsed.sessionId.trim()
    ) {
      return parsed.sessionId;
    }
  } catch {}
  return null;
}
