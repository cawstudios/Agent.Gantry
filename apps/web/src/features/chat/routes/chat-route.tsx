import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  LoaderCircle,
  MessageSquarePlus,
  RefreshCw,
  Search,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import { type FormEvent } from 'react';

import { useRuntimeConnection } from '../../../lib/api/runtime-connection';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import type { ConversationView } from '../../operations/conversation-api';
import { useConversationDashboard } from '../../operations/use-conversations';
import { useEnsureChatSession } from '../use-chat';

export function ChatRoute() {
  const search = useSearch({ from: '/chat' });
  const navigate = useNavigate({ from: '/chat' });
  const connection = useRuntimeConnection();
  const query = useConversationDashboard();
  const ensureSession = useEnsureChatSession();
  const needle = search.q.trim().toLowerCase();
  const agents = [
    'all',
    ...new Set(
      (query.data?.conversations ?? [])
        .map((conversation) => conversation.agent)
        .filter((agent) => agent !== 'Not installed'),
    ),
  ];
  const visible = (query.data?.conversations ?? []).filter(
    (conversation) =>
      (search.status === 'all' || conversation.status === search.status) &&
      (search.agent === 'all' || conversation.agent === search.agent) &&
      (!needle ||
        `${conversation.name} ${conversation.agent} ${conversation.provider}`
          .toLowerCase()
          .includes(needle)),
  );

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void navigate({ search: { ...search, q: String(form.get('q') ?? '') } });
  }

  async function openChat(conversation: ConversationView) {
    const result = await ensureSession.mutateAsync(conversation);
    await navigate({
      to: '/chat/$sessionId',
      params: { sessionId: result.sessionId },
      search: { inspector: 'thread' },
    });
  }

  return (
    <div className="mx-auto grid w-full max-w-[1100px] gap-6">
      <PageHeader
        eyebrow="Conversations"
        title="Chat"
        description="Open a durable Gantry session from a discovered conversation."
        action={
          connection.transport ? (
            <Button variant="secondary" onClick={() => void query.refetch()}>
              <RefreshCw size={16} aria-hidden="true" /> Reload
            </Button>
          ) : undefined
        }
      />

      {!connection.transport ? (
        <PageState
          description="Start Gantry with local-owner UI linkage to open chat sessions."
          icon={<WifiOff size={18} aria-hidden="true" />}
          kind="offline"
          title="Runtime not connected"
        />
      ) : query.isPending ? (
        <PageState
          description="Loading available conversations and installed agents."
          icon={
            <LoaderCircle
              className="animate-spin"
              size={18}
              aria-hidden="true"
            />
          }
          kind="loading"
          title="Loading chat entry points"
        />
      ) : query.isError ? (
        <PageState
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
          description={query.error.message}
          icon={<TriangleAlert size={18} aria-hidden="true" />}
          kind="error"
          title="Chat entry points could not be loaded"
        />
      ) : (
        <>
          <form
            className="grid items-end gap-3 lg:grid-cols-[minmax(0,1fr)_170px_190px_auto]"
            onSubmit={submitSearch}
          >
            <TextField
              defaultValue={search.q}
              id="chat-search"
              label="Search conversations"
              name="q"
              placeholder="Name, agent, or provider"
            />
            <FilterSelect
              label="Status"
              options={['all', 'active', 'inactive', 'archived']}
              value={search.status}
              onChange={(status) =>
                void navigate({ search: { ...search, status } })
              }
            />
            <FilterSelect
              label="Agent"
              options={agents}
              value={search.agent}
              onChange={(agent) =>
                void navigate({ search: { ...search, agent } })
              }
            />
            <Button variant="secondary" type="submit">
              <Search size={15} aria-hidden="true" /> Search
            </Button>
          </form>

          <Panel
            title="Available conversations"
            description={`${visible.length} conversations can open a durable session`}
          >
            <div className="divide-y divide-border">
              {visible.map((conversation) => (
                <article
                  className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  key={conversation.id}
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm text-text">
                        {conversation.name}
                      </strong>
                      <StatusBadge status={conversation.status} />
                    </span>
                    <span className="mt-1 block text-xs text-text-secondary">
                      {conversation.agent} · {conversation.provider} ·{' '}
                      {conversation.kind}
                    </span>
                  </span>
                  <Button
                    disabled={ensureSession.isPending}
                    onClick={() => void openChat(conversation)}
                  >
                    <MessageSquarePlus size={15} aria-hidden="true" />
                    Open chat
                  </Button>
                </article>
              ))}
              {visible.length === 0 ? (
                <p className="m-0 px-5 py-12 text-center text-sm text-text-secondary">
                  No conversations match these filters.
                </p>
              ) : null}
            </div>
            {ensureSession.isError ? (
              <p className="m-0 border-t border-border px-5 py-3 text-xs text-status-danger">
                {ensureSession.error.message}
              </p>
            ) : null}
          </Panel>
        </>
      )}
    </div>
  );
}

function FilterSelect<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-text">
      {label}
      <select
        className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option === 'all' ? `All ${label.toLowerCase()}s` : option}
          </option>
        ))}
      </select>
    </label>
  );
}
