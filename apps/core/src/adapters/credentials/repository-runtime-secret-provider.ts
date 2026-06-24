import type { AppId } from '../../domain/app/app.js';
import type {
  RuntimeSecretProvider,
  RuntimeSecretRef,
} from '../../domain/ports/runtime-secret-provider.js';
import { runtimeSecretRefTarget } from '../../domain/ports/runtime-secret-provider.js';
import type { CapabilitySecretRepository } from '../../domain/ports/repositories.js';
import { AwsSecretsManagerRuntimeSecretProvider } from './aws-secrets-manager-runtime-secret-provider.js';
import { EnvRuntimeSecretProvider } from './env-runtime-secret-provider.js';

export class RepositoryRuntimeSecretProvider implements RuntimeSecretProvider {
  constructor(
    private readonly input: {
      appId: AppId;
      repository: CapabilitySecretRepository;
      fallback: RuntimeSecretProvider;
    },
  ) {}

  getSecret(ref: RuntimeSecretRef): string {
    const value = this.getOptionalSecret(ref);
    if (!value)
      throw new Error(`${runtimeSecretRefTarget(ref).name} is required.`);
    return value;
  }

  getOptionalSecret(ref: RuntimeSecretRef): string | undefined {
    const target = runtimeSecretRefTarget(ref);
    return target.source !== 'gantry-secret'
      ? this.input.fallback.getOptionalSecret(ref)
      : undefined;
  }

  async getOptionalSecretAsync(
    ref: RuntimeSecretRef,
  ): Promise<string | undefined> {
    const target = runtimeSecretRefTarget(ref);
    if (target.source !== 'gantry-secret') {
      return (
        (await this.input.fallback.getOptionalSecretAsync?.(ref)) ??
        this.input.fallback.getOptionalSecret(ref)
      );
    }
    const secret = await this.input.repository.getSecret({
      appId: this.input.appId,
      name: target.name,
    });
    return secret?.value || undefined;
  }
}

export function createRepositoryRuntimeSecretProvider(input: {
  appId: AppId;
  repository: CapabilitySecretRepository;
}): RuntimeSecretProvider {
  return new RepositoryRuntimeSecretProvider({
    ...input,
    fallback: new AwsSecretsManagerRuntimeSecretProvider(
      new EnvRuntimeSecretProvider(),
    ),
  });
}
