import type { AppId } from '../../domain/app/app.js';
import type {
  ProviderConnection,
  ProviderConnectionId,
  ProviderId,
} from '../../domain/provider/provider.js';
import type { ProviderConnectionRepository } from '../../domain/ports/repositories.js';
import type { Clock } from '../common/clock.js';
import type { IdGenerator } from '../common/id-generator.js';

export interface CreateProviderConnectionInput {
  appId: AppId;
  providerId: ProviderId;
  label: string;
  config?: Record<string, unknown>;
  runtimeSecretRefs?: string[];
  enabled?: boolean;
}

export class CreateProviderConnectionUseCase {
  constructor(
    private readonly deps: {
      providerConnections: ProviderConnectionRepository;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async execute(input: CreateProviderConnectionInput) {
    const now = this.deps.clock.now();
    const providerConnection: ProviderConnection = {
      id: this.deps.ids.generate() as ProviderConnectionId,
      appId: input.appId,
      providerId: input.providerId,
      label: input.label.trim(),
      status: input.enabled === false ? 'disabled' : 'active',
      config: input.config ?? {},
      runtimeSecretRefs: input.runtimeSecretRefs ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.providerConnections.saveProviderConnection(
      providerConnection,
    );
    return { providerConnection };
  }
}
