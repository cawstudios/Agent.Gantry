export function schedulerJobSummary(job: unknown): string {
  const record =
    typeof job === 'object' && job !== null ? (job as Record<string, any>) : {};
  const visibility =
    typeof record.visibility === 'object' && record.visibility !== null
      ? (record.visibility as Record<string, any>)
      : {};
  const target =
    typeof visibility.target === 'object' && visibility.target !== null
      ? (visibility.target as Record<string, any>)
      : {};
  const executionContext =
    typeof visibility.executionContext === 'object' &&
    visibility.executionContext !== null
      ? (visibility.executionContext as Record<string, any>)
      : {};
  const notificationRoutes = Array.isArray(visibility.notificationRoutes)
    ? visibility.notificationRoutes
    : [];
  const recentErrors = Array.isArray(visibility.recentRunErrors)
    ? visibility.recentRunErrors.length
    : 0;
  const staleness =
    typeof visibility.staleness === 'string' ? visibility.staleness : 'none';
  const toolAccess = toolAccessRecord(visibility.toolAccess);
  const health =
    typeof visibility.health === 'object' && visibility.health !== null
      ? (visibility.health as Record<string, any>)
      : {};
  const toolAccessLine = toolAccess.present
    ? `Tool access: inherited ${formatTools(toolAccess.inheritedAgentTools)}, effective ${formatTools(toolAccess.effectiveAllowedTools)}, projected ${formatTools(toolAccess.projectedRuntimeTools)}`
    : 'Tool access: missing canonical toolAccess';
  const nextAction =
    typeof health.nextAction === 'string' && health.nextAction.trim()
      ? health.nextAction
      : 'none';
  return [
    `Job: ${String(record.name ?? record.id ?? 'unknown')}`,
    `Health: ${String(health.state ?? 'unknown')} | latest ${String(health.latestRunStatus ?? 'none')} | action ${nextAction}`,
    `Target: ${String(target.agentId ?? record.group_scope ?? 'unknown')} in ${String(target.conversationJids?.[0] ?? 'no conversation')}`,
    `Execution context: ${String(executionContext.conversationJid ?? 'unknown')} | thread ${String(executionContext.threadId ?? 'none')} | group ${String(executionContext.groupScope ?? record.group_scope ?? 'unknown')}`,
    `Notification routes: ${notificationRoutes.length}`,
    `Kind/status: ${String(record.schedule_type ?? 'unknown')} / ${String(record.status ?? 'unknown')}`,
    `Next/last run: ${String(record.next_run ?? 'none')} / ${String(record.last_run ?? 'none')}`,
    `Staleness: ${staleness}`,
    toolAccessLine,
    `Recent run errors: ${recentErrors}`,
    '',
    'Structured JSON:',
    JSON.stringify(record, null, 2),
  ].join('\n');
}

export function schedulerJobsSummary(jobs: unknown[]): string {
  const lines = jobs.map((job) => {
    const record =
      typeof job === 'object' && job !== null
        ? (job as Record<string, any>)
        : {};
    const visibility =
      typeof record.visibility === 'object' && record.visibility !== null
        ? (record.visibility as Record<string, any>)
        : {};
    const target =
      typeof visibility.target === 'object' && visibility.target !== null
        ? (visibility.target as Record<string, any>)
        : {};
    const executionContext =
      typeof visibility.executionContext === 'object' &&
      visibility.executionContext !== null
        ? (visibility.executionContext as Record<string, any>)
        : {};
    const toolAccess = toolAccessRecord(visibility.toolAccess);
    const health =
      typeof visibility.health === 'object' && visibility.health !== null
        ? (visibility.health as Record<string, any>)
        : {};
    const toolsLabel = toolAccess.present
      ? formatTools(toolAccess.effectiveAllowedTools)
      : '(missing toolAccess)';
    return `- ${String(record.id ?? 'unknown')} | ${String(record.name ?? '')} | ${String(health.state ?? record.status ?? '')} | ${String(executionContext.conversationJid ?? target.conversationJids?.[0] ?? '')} | tools: ${toolsLabel}`;
  });
  return [
    `Scheduler jobs (${jobs.length})`,
    ...lines,
    '',
    'Structured JSON:',
    JSON.stringify(jobs, null, 2),
  ].join('\n');
}

function toolAccessRecord(value: unknown): {
  present: boolean;
  inheritedAgentTools: string[];
  effectiveAllowedTools: string[];
  projectedRuntimeTools: string[];
} {
  const present = typeof value === 'object' && value !== null;
  const record =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    present,
    inheritedAgentTools: stringArray(record.inheritedAgentTools),
    effectiveAllowedTools: stringArray(record.effectiveAllowedTools),
    projectedRuntimeTools: stringArray(record.projectedRuntimeTools),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function formatTools(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}
