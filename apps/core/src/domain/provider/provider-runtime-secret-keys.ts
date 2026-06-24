import {
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../ports/runtime-secret-provider.js';

export function runtimeSecretKeyForEnv(
  providerId: string,
  envKey: string,
): string {
  const canonical = envKey.trim().toUpperCase();
  return canonical
    .replace(new RegExp(`^${providerEnvPrefix(providerId)}_`), '')
    .toLowerCase();
}

export function expectedRuntimeSecretEnvForKey(
  providerId: string,
  key: string,
): string | undefined {
  const normalizedKey = key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(normalizedKey)) return undefined;
  return `${providerEnvPrefix(providerId)}_${normalizedKey}`;
}

export function isProviderRuntimeSecretRefTarget(
  providerId: string,
  key: string,
  ref: string,
): boolean {
  const expectedEnv = expectedRuntimeSecretEnvForKey(providerId, key);
  if (!expectedEnv) return false;
  const parsed = parseRuntimeSecretRefString(
    normalizeRuntimeSecretRefString(ref),
  );
  if (parsed.source === 'aws-sm') return true;
  return isProviderScopedSecretName(providerId, key, parsed.name, expectedEnv);
}

function providerEnvPrefix(providerId: string): string {
  return providerId
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toUpperCase();
}

function isProviderScopedSecretName(
  providerId: string,
  key: string,
  name: string,
  expectedEnv: string,
): boolean {
  if (name === expectedEnv) return true;
  const providerPrefix = escapeRegExp(providerEnvPrefix(providerId));
  const normalizedKey = key.trim().toUpperCase();
  return (
    new RegExp(`(^|_)${providerPrefix}_`).test(name) &&
    name.endsWith(`_${normalizedKey}`)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
