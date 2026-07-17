import { CheckCircle2, Clock3, XCircle } from 'lucide-react';

import { StatusBadge } from '../../../ui/compositions/status-badge';
import type { ChatRun, ChatSession } from '../chat-api';

export type ChatInspectorTab = 'thread' | 'timeline';

export function ChatInspector({
  session,
  tab,
}: {
  session: ChatSession;
  tab: ChatInspectorTab;
}) {
  if (tab === 'thread') {
    return (
      <div className="grid gap-4 p-4">
        <Detail label="Agent" value={session.agent} />
        <Detail label="Conversation" value={session.conversation} />
        <Detail
          label="Session status"
          value={<StatusBadge status={session.status} />}
        />
        <Detail
          label="Provider session"
          value={
            session.providerSession ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                {session.providerSession.provider}
                <StatusBadge status={session.providerSession.status} />
              </span>
            ) : (
              'Not established'
            )
          }
        />
        <Detail label="Thread ID" value={session.threadId ?? 'None'} />
        <Detail label="Created" value={formatDate(session.createdAt)} />
        <Detail label="Updated" value={formatDate(session.updatedAt)} />
      </div>
    );
  }

  return <RunTimeline runs={session.runs} />;
}

function RunTimeline({ runs }: { runs: ChatRun[] }) {
  return (
    <div className="grid gap-4 p-4">
      {runs.map((run) => (
        <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-3" key={run.id}>
          <span className={runTone(run.status)}>
            <RunIcon status={run.status} />
          </span>
          <span>
            <strong className="block text-[13px] text-text">
              {run.status}
            </strong>
            <span className="mt-1 block text-xs leading-5 text-text-secondary">
              {run.resultSummary ??
                run.errorSummary ??
                `Started ${formatDate(run.startedAt ?? run.createdAt)}`}
            </span>
          </span>
        </div>
      ))}
      {runs.length === 0 ? (
        <p className="m-0 py-8 text-center text-xs text-text-secondary">
          No runs are stored for this session.
        </p>
      ) : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border pb-3 last:border-0">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="text-[13px] font-medium text-text">{value}</span>
    </div>
  );
}

function RunIcon({ status }: { status: ChatRun['status'] }) {
  if (status === 'completed') {
    return <CheckCircle2 size={16} aria-hidden="true" />;
  }
  if (status === 'failed' || status === 'canceled') {
    return <XCircle size={16} aria-hidden="true" />;
  }
  return <Clock3 size={16} aria-hidden="true" />;
}

function runTone(status: ChatRun['status']): string {
  if (status === 'completed') return 'text-status-success';
  if (status === 'failed' || status === 'canceled') return 'text-status-danger';
  return 'text-status-attention';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
