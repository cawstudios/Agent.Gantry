export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function isUnsafeEvidence(evidence: { metadataJson: unknown }): boolean {
  const metadata = parseJsonObject(evidence.metadataJson);
  return (
    metadata.unsafeSource === true ||
    metadata.quarantined === true ||
    metadata.promptInjection === true ||
    metadata.safety === 'unsafe' ||
    metadata.safety === 'quarantined'
  );
}
