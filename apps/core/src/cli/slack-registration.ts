import { providerForJid } from '../channels/provider-registry.js';
import type { AgentConfig, ConversationRoute } from '../domain/types.js';

interface SlackRouteSeedSettings {
  conversations: Record<
    string,
    { providerConnection: string; externalId: string }
  >;
  providerConnections: Record<string, { provider: string }>;
  bindings: Record<
    string,
    {
      agent: string;
      conversation: string;
      trigger: string;
      addedAt?: string;
      model?: string;
    }
  >;
  agents: Record<
    string,
    { name: string } & Pick<
      AgentConfig,
      'persona' | 'relationshipMode' | 'model'
    >
  >;
}

export function configuredSlackRouteSeed(
  settings: SlackRouteSeedSettings,
  chatJid: string,
):
  | {
      folder: string;
      groupName: string;
      trigger: string;
      addedAt?: string;
      agentConfig?: ConversationRoute['agentConfig'];
    }
  | undefined {
  const provider = providerForJid(chatJid);
  if (!provider) return undefined;
  const externalId = chatJid.startsWith(provider.jidPrefix)
    ? chatJid.slice(provider.jidPrefix.length)
    : chatJid;
  const conversationEntry = Object.entries(settings.conversations).find(
    ([, conversation]) => {
      const connection =
        settings.providerConnections[conversation.providerConnection];
      return (
        connection?.provider === provider.id &&
        conversation.externalId === externalId
      );
    },
  );
  if (!conversationEntry) return undefined;

  const [conversationId] = conversationEntry;
  const binding = Object.values(settings.bindings).find(
    (candidate) => candidate.conversation === conversationId,
  );
  if (!binding) return undefined;
  const agent = settings.agents[binding.agent];
  if (!agent) return undefined;

  return {
    folder: binding.agent,
    groupName: agent.name,
    trigger: binding.trigger,
    addedAt: binding.addedAt,
    agentConfig:
      binding.model || agent.persona || agent.relationshipMode
        ? {
            model: binding.model,
            persona: agent.persona,
            relationshipMode: agent.relationshipMode,
          }
        : undefined,
  };
}
