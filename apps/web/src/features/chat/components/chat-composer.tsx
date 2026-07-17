import { Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Button } from '../../../ui/primitives/button';

const MAX_DRAFT_CHARACTERS = 20_000;

export function ChatComposer({
  disabled,
  onSend,
}: {
  disabled?: boolean;
  onSend: (message: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || disabled) return;
    void onSend(message).then(
      () => setDraft(''),
      () => undefined,
    );
  }

  return (
    <form
      className="grid gap-3 border-t border-border bg-surface p-4"
      onSubmit={submit}
    >
      <label className="sr-only" htmlFor="chat-draft">
        Message
      </label>
      <textarea
        className="min-h-24 w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-sm leading-6 text-text placeholder:text-text-muted"
        disabled={disabled}
        id="chat-draft"
        maxLength={MAX_DRAFT_CHARACTERS}
        placeholder="Write a message"
        value={draft}
        onChange={(event) =>
          setDraft(event.target.value.slice(0, MAX_DRAFT_CHARACTERS))
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-[10px] text-text-muted">
          {draft.length.toLocaleString()} /{' '}
          {MAX_DRAFT_CHARACTERS.toLocaleString()}
        </span>
        <Button disabled={disabled || !draft.trim()} type="submit">
          <Send size={16} aria-hidden="true" />
          {disabled ? 'Sending' : 'Send'}
        </Button>
      </div>
      <p className="m-0 text-[11px] leading-4 text-text-muted">
        Sent as Local owner. Server messages remain the durable record.
      </p>
    </form>
  );
}
