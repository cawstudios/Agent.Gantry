import {
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../domain/ports/runtime-secret-provider.js';
import { runtimeSecretKeyForEnv } from '../domain/provider/provider-runtime-secret-keys.js';

export function resolveRuntimeEnvValue(
  env: Record<string, string>,
  key: string,
): string {
  return env[key]?.trim() || process.env[key]?.trim() || '';
}

interface RuntimeCredentialSettings {
  providers: Record<string, { defaultConnection?: string } | undefined>;
  providerConnections: Record<
    string,
    { runtimeSecretRefs: Record<string, string | undefined> } | undefined
  >;
}

function hasRuntimeSecretRefConfigured(
  ref: string | undefined,
  env: Record<string, string>,
): boolean {
  const value = ref?.trim();
  if (!value) return false;
  try {
    const parsed = parseRuntimeSecretRefString(
      normalizeRuntimeSecretRefString(value),
    );
    return parsed.source === 'env'
      ? Boolean(resolveRuntimeEnvValue(env, parsed.name))
      : true;
  } catch {
    return false;
  }
}

function runtimeSecretRefSource(
  ref: string | undefined,
): 'env' | 'stored' | null {
  const value = ref?.trim();
  if (!value) return null;
  try {
    const parsed = parseRuntimeSecretRefString(
      normalizeRuntimeSecretRefString(value),
    );
    return parsed.source === 'env' ? 'env' : 'stored';
  } catch {
    return null;
  }
}

export function hasRuntimeCredentialConfigured(input: {
  settings?: RuntimeCredentialSettings;
  env: Record<string, string>;
  providerId: string;
  envKey: string;
  unresolvedRuntimeSecretProviderIds?: Set<string>;
}): boolean {
  const connectionId =
    input.settings?.providers[input.providerId]?.defaultConnection;
  const refs = connectionId
    ? input.settings?.providerConnections[connectionId]?.runtimeSecretRefs
    : undefined;
  const refKey = runtimeSecretKeyForEnv(input.providerId, input.envKey);
  const rawRef = refs?.[refKey];
  if (
    input.unresolvedRuntimeSecretProviderIds?.has(input.providerId) &&
    runtimeSecretRefSource(rawRef) === 'stored'
  ) {
    return false;
  }
  return (
    hasRuntimeSecretRefConfigured(rawRef, input.env) ||
    Boolean(resolveRuntimeEnvValue(input.env, input.envKey))
  );
}
