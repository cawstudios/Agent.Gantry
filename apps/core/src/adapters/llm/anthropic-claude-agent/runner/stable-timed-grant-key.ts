export function stableTimedGrantKey(value: unknown): string {
  return JSON.stringify(stableTimedGrantValue(value));
}

function stableTimedGrantValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableTimedGrantValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableTimedGrantValue(record[key])]),
  );
}
