import type { AgentConversationBinding } from '../../domain/provider/provider.js';
import { notImplemented } from '../common/application-error.js';

export class DisableAgentInConversationUseCase {
  async execute(input: { binding: AgentConversationBinding }) {
    void input;
    // TODO(next-phase): add binding status to the domain model or a repository delete contract.
    throw notImplemented('DisableAgentInConversationUseCase');
  }
}
