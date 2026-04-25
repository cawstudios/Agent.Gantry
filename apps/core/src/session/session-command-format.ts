import type { ThinkingOverride } from '../domain/types.js';

interface MemoryStatusSnapshotLike {
  items_by_kind: Record<string, number>;
  items_by_scope: Record<string, number>;
  top10_most_used: Array<{ key: string; retrieval_count: number }>;
  top10_stalest: Array<{ key: string; updated_at: string }>;
  last_dream_run?: { at?: string; summary?: string };
  disk_kb?: Record<string, number>;
}

export function formatMemoryStatus(status: MemoryStatusSnapshotLike): string {
  const kinds = Object.entries(status.items_by_kind || {})
    .map(([kind, count]) => `${kind}:${count}`)
    .join(', ');
  const scopes = Object.entries(status.items_by_scope || {})
    .map(([scope, count]) => `${scope}:${count}`)
    .join(', ');
  const used = (status.top10_most_used || [])
    .slice(0, 5)
    .map((row) => `${row.key}(${row.retrieval_count})`)
    .join(', ');
  const stalest = (status.top10_stalest || [])
    .slice(0, 5)
    .map((row) => `${row.key}@${row.updated_at.slice(0, 10)}`)
    .join(', ');
  const dream = status.last_dream_run?.at || 'never';
  const disk = status.disk_kb
    ? Object.entries(status.disk_kb)
        .map(([k, v]) => `${k}:${v}kb`)
        .join(', ')
    : 'n/a';
  return [
    'Memory status',
    `kinds: ${kinds || 'none'}`,
    `scopes: ${scopes || 'none'}`,
    `top_used: ${used || 'none'}`,
    `stale: ${stalest || 'none'}`,
    `last_dream: ${dream}`,
    `disk: ${disk}`,
  ].join('\n');
}

export function describeThinking(value: ThinkingOverride): string {
  if (value.mode === 'disabled') return 'disabled';
  if (value.mode === 'adaptive') {
    if (value.effort) return `adaptive (effort ${value.effort})`;
    return 'adaptive';
  }
  if (value.mode === 'enabled') {
    if (typeof value.budgetTokens === 'number') {
      return `enabled (budget ${value.budgetTokens} tokens)`;
    }
    return 'enabled';
  }
  return value.mode;
}

export function formatCurrentModel(
  defaultModel: string | undefined,
  groupOverrideModel: string | undefined,
): string {
  if (groupOverrideModel) {
    return `Current model: ${groupOverrideModel} (group override).`;
  }
  if (defaultModel) return `Current model: ${defaultModel} (default).`;
  return 'Current model: CLI default (no explicit override).';
}
