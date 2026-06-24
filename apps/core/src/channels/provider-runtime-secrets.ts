import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import {
  envRuntimeSecretRef,
  getOptionalRuntimeSecret,
} from '../domain/ports/runtime-secret-provider.js';

interface ProviderRuntimeSecretSettings {
  providers: Record<string, { defaultConnection?: string } | undefined>;
  providerConnections: Record<
    string,
    { runtimeSecretRefs: Record<string, string | undefined> } | undefined
  >;
}

export async function getProviderRuntimeSecret(input: {
  providerId: string;
  key: string;
  defaultEnvName: string;
  settings?: ProviderRuntimeSecretSettings;
  secrets?: RuntimeSecretProvider;
}): Promise<string> {
  const ref =
    input.settings?.providerConnections[
      input.settings.providers[input.providerId]?.defaultConnection || ''
    ]?.runtimeSecretRefs[input.key] ??
    envRuntimeSecretRef(input.defaultEnvName);
  return (await getOptionalRuntimeSecret(input.secrets, { ref }))?.trim() || '';
}
