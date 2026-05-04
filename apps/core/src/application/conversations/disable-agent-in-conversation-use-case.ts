import type { AgentConversationBinding } from '../../domain/provider/provider.js';
import { ApplicationError } from '../common/application-error.js';

export class DisableAgentInConversationUseCase {
  async execute(input: { binding: AgentConversationBinding }) {
    throw new ApplicationError(
      'UNAVAILABLE',
      'Disabling an agent conversation binding requires a binding repository write port before it can be executed.',
      { details: [`bindingId=${input.binding.id}`] },
    );
  }
}
