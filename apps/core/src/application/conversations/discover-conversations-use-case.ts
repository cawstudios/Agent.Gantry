import type { ProviderConnectionId } from '../../domain/provider/provider.js';
import type { Conversation } from '../../domain/conversation/conversation.js';

export interface ConversationDiscoveryPort {
  discover(input: {
    providerConnectionId: ProviderConnectionId;
  }): Promise<Conversation[]>;
}

export class DiscoverConversationsUseCase {
  constructor(private readonly discovery: ConversationDiscoveryPort) {}

  async execute(input: { providerConnectionId: ProviderConnectionId }) {
    return { conversations: await this.discovery.discover(input) };
  }
}
