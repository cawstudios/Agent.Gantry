import type { AgentConversationBinding } from '../../domain/provider/provider.js';
import type { ProviderConnectionRepository } from '../../domain/ports/repositories.js';

export class EnableAgentInConversationUseCase {
  constructor(
    private readonly deps: {
      providerConnections: ProviderConnectionRepository;
    },
  ) {}

  async execute(input: { binding: AgentConversationBinding }) {
    await this.deps.providerConnections.saveAgentConversationBinding(
      input.binding,
    );
    return { binding: input.binding };
  }
}
