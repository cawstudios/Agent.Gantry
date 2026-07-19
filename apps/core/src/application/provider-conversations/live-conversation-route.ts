import type { AgentConfig, ConversationRoute } from '../../domain/types.js';
import { defaultTriggerForAgentName } from '../../shared/trigger-pattern.js';

export type LiveConversationRoute = ConversationRoute & {
  agentId: string;
  providerAccountId: string;
  requiresTrigger: boolean;
  conversationKind: 'dm' | 'channel';
};

type LiveConversationRouteTrigger =
  | { trigger: string; agentName?: never }
  | { trigger?: never; agentName: string };

export function liveConversationRoute(
  input: {
    displayName: string;
    agentFolder: string;
    agentId: string;
    providerAccountId: string;
    conversationId?: string;
    addedAt: string;
    requiresTrigger: boolean;
    conversationKind: 'dm' | 'channel';
    agentConfig?: AgentConfig;
  } & LiveConversationRouteTrigger,
): LiveConversationRoute {
  return {
    name: input.displayName,
    folder: input.agentFolder,
    agentId: input.agentId,
    providerAccountId: input.providerAccountId,
    conversationId: input.conversationId,
    trigger: input.trigger ?? defaultTriggerForAgentName(input.agentName),
    added_at: input.addedAt,
    requiresTrigger: input.requiresTrigger,
    conversationKind: input.conversationKind,
    agentConfig: input.agentConfig,
  };
}
