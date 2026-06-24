import { inspectRuntimeSecretReadiness } from '../adapters/storage/postgres/storage-readiness.js';
import {
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../domain/ports/runtime-secret-provider.js';

interface RuntimeSecretStatusSettings {
  providers: Record<
    string,
    { enabled: boolean; defaultConnection?: string } | undefined
  >;
  providerConnections: Record<
    string,
    { runtimeSecretRefs: Record<string, string | undefined> } | undefined
  >;
  storage: {
    postgres: {
      urlEnv: string;
      schema: string;
    };
  };
}

export async function collectUnresolvedRuntimeSecretProviderIds(
  runtimeHome: string,
  settings: RuntimeSecretStatusSettings,
): Promise<Set<string>> {
  try {
    const readiness = await inspectRuntimeSecretReadiness(
      runtimeHome,
      settings,
    );
    return unresolvedProviderIdsFromRuntimeSecretDetails(
      readiness.status === 'fail' ? (readiness.details ?? []) : [],
    );
  } catch {
    return providersWithStorageBackedRuntimeSecretRefs(settings);
  }
}

export function unresolvedProviderIdsFromRuntimeSecretDetails(
  details: string[],
): Set<string> {
  const providerIds = new Set<string>();
  for (const detail of details) {
    const match = /^providers\.([^.]+)\./.exec(detail);
    if (match) providerIds.add(match[1]);
  }
  return providerIds;
}

export function isMissingRuntimeCredential(input: {
  providerId: string;
  envKey: string;
  rawRef?: string;
  env: Record<string, string>;
  unresolvedRuntimeSecretProviderIds: Set<string>;
}): boolean {
  const refSource = runtimeSecretRefSource(input.rawRef);
  if (refSource === 'env') {
    const envName = runtimeSecretEnvName(input.rawRef) ?? input.envKey;
    return !input.env[envName]?.trim();
  }
  if (refSource === 'stored') {
    return input.unresolvedRuntimeSecretProviderIds.has(input.providerId);
  }
  return !input.env[input.envKey]?.trim();
}

function providersWithStorageBackedRuntimeSecretRefs(
  settings: RuntimeSecretStatusSettings,
): Set<string> {
  const providerIds = new Set<string>();
  for (const [providerId, providerSettings] of Object.entries(
    settings.providers,
  )) {
    if (!providerSettings?.enabled) continue;
    const connectionId = providerSettings.defaultConnection;
    const refs = connectionId
      ? settings.providerConnections[connectionId]?.runtimeSecretRefs
      : undefined;
    for (const rawRef of Object.values(refs ?? {})) {
      if (runtimeSecretRefSource(rawRef) === 'stored') {
        providerIds.add(providerId);
      }
    }
  }
  return providerIds;
}

function runtimeSecretRefSource(rawRef?: string): 'env' | 'stored' | null {
  if (!rawRef?.trim()) return null;
  try {
    const normalized = normalizeRuntimeSecretRefString(rawRef);
    return parseRuntimeSecretRefString(normalized).source === 'env'
      ? 'env'
      : 'stored';
  } catch {
    return 'stored';
  }
}

function runtimeSecretEnvName(rawRef?: string): string | null {
  if (!rawRef?.trim()) return null;
  try {
    const normalized = normalizeRuntimeSecretRefString(rawRef);
    const parsed = parseRuntimeSecretRefString(normalized);
    return parsed.source === 'env' ? parsed.name : null;
  } catch {
    return null;
  }
}
