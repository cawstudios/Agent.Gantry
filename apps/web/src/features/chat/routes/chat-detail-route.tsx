import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ArrowLeft,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import { useState } from 'react';

import { useRuntimeConnection } from '../../../lib/api/runtime-connection';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { RouteTabs, type RouteTab } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { useConversationDashboard } from '../../operations/use-conversations';
import type { ChatSession } from '../chat-api';
import { ChatComposer } from '../components/chat-composer';
import {
  ChatInspector,
  type ChatInspectorTab,
} from '../components/chat-inspector';
import { ChatThread } from '../components/chat-thread';
import {
  useChatSession,
  useSendChatMessage,
  useSessionEventStream,
} from '../use-chat';

const inspectorTabs: RouteTab<ChatInspectorTab>[] = [
  { value: 'thread', label: 'Details' },
  { value: 'timeline', label: 'Runs' },
];

export function ChatDetailRoute() {
  const { sessionId } = useParams({ from: '/chat/$sessionId' });
  const connection = useRuntimeConnection();
  const dashboard = useConversationDashboard();
  const query = useChatSession(sessionId, dashboard.data);

  if (!connection.transport) {
    return (
      <PageState
        description="Start Gantry with local-owner UI linkage to load this session."
        icon={<WifiOff size={18} aria-hidden="true" />}
        kind="offline"
        title="Runtime not connected"
      />
    );
  }
  if (dashboard.isPending || query.isPending) {
    return (
      <PageState
        description="Loading durable messages, session state, and runs."
        icon={
          <LoaderCircle className="animate-spin" size={18} aria-hidden="true" />
        }
        kind="loading"
        title="Loading chat session"
      />
    );
  }
  if (dashboard.isError || query.isError) {
    const error = dashboard.error ?? query.error;
    return (
      <PageState
        action={
          <Button
            onClick={() => {
              void dashboard.refetch();
              void query.refetch();
            }}
          >
            <RefreshCw size={16} aria-hidden="true" /> Retry
          </Button>
        }
        description={error?.message ?? 'Chat session could not be loaded.'}
        icon={<TriangleAlert size={18} aria-hidden="true" />}
        kind="error"
        title="Chat session could not be loaded"
      />
    );
  }
  return query.data ? <ChatSessionContent session={query.data} /> : null;
}

function ChatSessionContent({ session }: { session: ChatSession }) {
  const search = useSearch({ from: '/chat/$sessionId' });
  const navigate = useNavigate({ from: '/chat/$sessionId' });
  const send = useSendChatMessage(session.id, session.threadId);
  const [afterEventId, setAfterEventId] = useState<number | null>(null);
  const stream = useSessionEventStream(session.id, afterEventId);
  const streamActive = ['connecting', 'streaming', 'reconnecting'].includes(
    stream.status,
  );

  async function sendMessage(message: string) {
    const result = await send.mutateAsync(message);
    setAfterEventId(result.acceptedEventId);
  }

  return (
    <div className="mx-auto grid w-full max-w-[1320px] gap-5">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        search={{ q: '', status: 'all', agent: 'all' }}
        to="/chat"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Chat
      </Link>
      <PageHeader
        eyebrow={`${session.agent} · ${session.conversation}`}
        title={session.title}
        description={`Durable session ${session.id}`}
        action={
          <span className="flex flex-wrap items-center gap-2">
            {stream.status !== 'idle' ? (
              <Badge tone={stream.status === 'error' ? 'danger' : 'attention'}>
                {stream.status}
              </Badge>
            ) : null}
            <StatusBadge status={session.status} />
          </span>
        }
      />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel
          title="Thread"
          description={`${session.messages.length} stored messages`}
          action={<MessageSquareText size={16} aria-hidden="true" />}
        >
          <div className="max-h-[760px] overflow-y-auto">
            <ChatThread
              messages={session.messages}
              streamText={stream.text}
              streaming={streamActive}
            />
          </div>
          {send.isError ? (
            <p className="m-0 border-t border-border px-4 py-3 text-xs text-status-danger">
              {send.error.message}
            </p>
          ) : null}
          {stream.error ? (
            <p className="m-0 border-t border-border px-4 py-3 text-xs text-status-danger">
              {stream.error}
            </p>
          ) : null}
          <ChatComposer
            disabled={send.isPending || streamActive}
            onSend={sendMessage}
          />
        </Panel>

        <Panel
          title="Session inspector"
          description="Canonical runtime state"
          action={<ListTree size={16} aria-hidden="true" />}
        >
          <RouteTabs
            label="Session inspector"
            tabs={inspectorTabs}
            value={search.inspector}
            onValueChange={(inspector) =>
              void navigate({ search: { inspector } })
            }
          />
          <ChatInspector session={session} tab={search.inspector} />
        </Panel>
      </div>
    </div>
  );
}
