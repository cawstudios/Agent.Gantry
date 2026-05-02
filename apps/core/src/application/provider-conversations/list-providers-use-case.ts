import type { Provider } from '../../domain/provider/provider.js';
import type { ProviderCatalogPort } from './provider-catalog-ports.js';

export class ListProvidersUseCase {
  constructor(private readonly providers: ProviderCatalogPort) {}

  async execute(): Promise<{ providers: Provider[] }> {
    return { providers: await this.providers.listProviders() };
  }
}
