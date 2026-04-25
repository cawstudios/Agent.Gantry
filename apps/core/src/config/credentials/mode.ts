export type HostCredentialMode = 'onecli';

export function parseHostCredentialMode(
  raw: string | undefined,
): HostCredentialMode | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'onecli') return 'onecli';
  return undefined;
}

export function resolveHostCredentialMode(
  rawMode: string | undefined,
): HostCredentialMode {
  const parsed = parseHostCredentialMode(rawMode);
  if (parsed) return parsed;
  return 'onecli';
}
