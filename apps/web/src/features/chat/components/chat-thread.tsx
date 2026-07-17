import { Bot, LoaderCircle, UserRound } from 'lucide-react';

import type { ChatMessage } from '../chat-api';

export function ChatThread({
  messages,
  streamText,
  streaming,
}: {
  messages: ChatMessage[];
  streamText?: string;
  streaming?: boolean;
}) {
  return (
    <div aria-label="Messages" className="grid gap-6 p-4 sm:p-5">
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
      {streaming || streamText ? (
        <article className="grid w-full gap-3" aria-live="polite">
          <MessageHeader author="Gantry" createdAt="Streaming now" />
          <div className="max-w-3xl text-sm leading-6 text-text">
            {streamText ? (
              <p className="m-0 whitespace-pre-wrap">{streamText}</p>
            ) : (
              <span className="inline-flex items-center gap-2 text-text-secondary">
                <LoaderCircle
                  className="animate-spin"
                  size={15}
                  aria-hidden="true"
                />
                Waiting for the agent response
              </span>
            )}
          </div>
        </article>
      ) : null}
      {messages.length === 0 && !streaming && !streamText ? (
        <p className="m-0 py-12 text-center text-sm text-text-secondary">
          No messages are stored in this session yet.
        </p>
      ) : null}
    </div>
  );
}

function MessageItem({ message }: { message: ChatMessage }) {
  return (
    <article
      className={`grid gap-3 ${
        message.role === 'user' ? 'ml-auto w-[min(100%,760px)]' : 'w-full'
      }`}
    >
      <MessageHeader author={message.author} createdAt={message.createdAt} />
      <div
        className={
          message.role === 'user'
            ? 'rounded-md bg-ink px-4 py-3 text-sm leading-6 text-ink-on'
            : message.role === 'system'
              ? 'border-l-2 border-status-attention px-4 text-sm leading-6 text-text-secondary'
              : 'max-w-3xl text-sm leading-6 text-text'
        }
      >
        <p className="m-0 whitespace-pre-wrap">{message.content}</p>
      </div>
    </article>
  );
}

function MessageHeader({
  author,
  createdAt,
}: {
  author: string;
  createdAt: string;
}) {
  return (
    <header className="flex items-center gap-2 text-xs text-text-muted">
      <span className="flex size-7 items-center justify-center rounded-full bg-surface-strong text-text-secondary">
        {author === 'Local owner' || author === 'User' ? (
          <UserRound size={14} aria-hidden="true" />
        ) : (
          <Bot size={14} aria-hidden="true" />
        )}
      </span>
      <strong className="font-semibold text-text">{author}</strong>
      <span>{formatDate(createdAt)}</span>
    </header>
  );
}

function formatDate(value: string): string {
  if (value === 'Streaming now') return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
