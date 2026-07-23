import { Button } from '../../../ui/primitives/button';
import type { ConversationView } from '../../operations/conversation-api';
import { useReplaceConversationInstall } from '../../operations/use-conversations';

export function SetupConversationDetails({
  agentId,
  conversations,
  selectedConversationId,
  onSelect,
}: {
  agentId?: string;
  conversations: ConversationView[];
  selectedConversationId: string;
  onSelect: (conversationId: string) => void;
}) {
  const replaceInstall = useReplaceConversationInstall();
  const selectedConversation = conversations.find(
    (conversation) => conversation.id === selectedConversationId,
  );

  return (
    <div className="grid gap-4">
      <label className="grid gap-1.5 text-xs font-semibold text-text">
        Conversation
        <select
          className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text disabled:text-text-muted"
          disabled={conversations.length === 0}
          value={selectedConversationId}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">
            {conversations.length === 0
              ? 'No conversations are available.'
              : 'Choose a conversation'}
          </option>
          {conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.name} · {conversation.provider}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={
            !agentId || !selectedConversation || replaceInstall.isPending
          }
          onClick={() => {
            if (!agentId || !selectedConversation) return;
            replaceInstall.mutate({
              conversation: selectedConversation,
              currentAgentId: selectedConversation.agentId,
              nextAgentId: agentId,
            });
          }}
        >
          {replaceInstall.isPending
            ? 'Saving access…'
            : 'Save conversation access'}
        </Button>
        {!agentId ? (
          <span className="text-sm text-text-muted">
            Create the agent before assigning a conversation.
          </span>
        ) : null}
      </div>
      {replaceInstall.isError ? (
        <p className="m-0 text-sm text-danger">
          {replaceInstall.error.message}
        </p>
      ) : null}
      {replaceInstall.isSuccess ? (
        <p className="m-0 text-sm text-status-ready">
          Conversation access saved.
        </p>
      ) : null}
    </div>
  );
}
