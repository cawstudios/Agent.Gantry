import { describe, expect, it } from 'vitest';

import { DisableAgentInConversationUseCase } from '@core/application/conversations/disable-agent-in-conversation-use-case.js';
import { EvaluateToolActionUseCase } from '@core/application/tools/evaluate-tool-action-use-case.js';

const iso = '2026-05-04T00:00:00.000Z';

describe('blocked application use cases', () => {
  it('blocks conversation disabling with actionable repository guidance', async () => {
    const useCase = new DisableAgentInConversationUseCase();

    await expect(
      useCase.execute({
        binding: {
          id: 'binding-1',
          appId: 'app-one',
          agentId: 'agent-one',
          providerConnectionId: 'provider-connection-one',
          conversationId: 'conversation-one',
          displayName: 'Engineering',
          status: 'active',
          triggerMode: 'always',
          requiresTrigger: false,
          isAdminBinding: false,
          memoryScope: 'conversation',
          memorySubject: { kind: 'conversation', id: 'conversation-one' },
          permissionPolicyIds: [],
          createdAt: iso,
          updatedAt: iso,
        } as never,
      }),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message:
        'Disabling an agent conversation binding requires a binding repository write port before it can be executed.',
      details: ['bindingId=binding-1'],
    });
  });

  it('blocks tool action evaluation with actionable permission repository guidance', async () => {
    const useCase = new EvaluateToolActionUseCase();

    await expect(
      useCase.execute({ action: { type: 'host_tool', name: 'send_message' } }),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message:
        'Tool action evaluation requires a permission policy repository before decisions can be produced.',
      details: ['actionType=host_tool'],
    });
  });
});
