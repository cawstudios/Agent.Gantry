import { useState } from 'react';
import { Button } from '@telegram-apps/telegram-ui';
import { impact } from '../lib/telegram';

interface SectionActionsProps {
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
  onSuggestEdit: () => void;
}

export function SectionActions({
  onApprove,
  onReject,
  onSuggestEdit,
}: SectionActionsProps) {
  const [busyAction, setBusyAction] = useState<'approve' | 'reject' | null>(
    null,
  );

  return (
    <div className="section-actions">
      <Button
        type="button"
        size="s"
        mode="filled"
        loading={busyAction === 'approve'}
        onClick={() => {
          impact('medium');
          setBusyAction('approve');
          void onApprove().finally(() => setBusyAction(null));
        }}
      >
        Approve
      </Button>
      <Button
        type="button"
        size="s"
        mode="outline"
        loading={busyAction === 'reject'}
        onClick={() => {
          impact('light');
          setBusyAction('reject');
          void onReject().finally(() => setBusyAction(null));
        }}
      >
        Reject
      </Button>
      <Button
        type="button"
        size="s"
        mode="bezeled"
        onClick={() => {
          impact('light');
          onSuggestEdit();
        }}
      >
        Suggest Edit
      </Button>
    </div>
  );
}
