import { Button } from '../../../ui/primitives/button';
import {
  useConversationDashboard,
  useDiscoverConversations,
} from '../../operations/use-conversations';

export function SetupConnectionDetails({
  selectedAccountId,
  onSelect,
}: {
  selectedAccountId: string;
  onSelect: (accountId: string) => void;
}) {
  const dashboard = useConversationDashboard();
  const discover = useDiscoverConversations();
  const accounts = dashboard.data?.providerAccounts ?? [];

  if (dashboard.isPending) {
    return (
      <p className="m-0 text-sm text-text-secondary">Loading connections…</p>
    );
  }

  return (
    <div className="grid gap-4">
      <label className="grid gap-1.5 text-xs font-semibold text-text">
        Provider connection
        <select
          className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text disabled:text-text-muted"
          disabled={accounts.length === 0}
          value={selectedAccountId}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">
            {accounts.length === 0
              ? 'No provider connections are available.'
              : 'Choose a provider connection'}
          </option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!selectedAccountId || discover.isPending}
          onClick={() => discover.mutate(selectedAccountId)}
        >
          {discover.isPending
            ? 'Discovering conversations…'
            : 'Discover conversations'}
        </Button>
        <span className="text-sm text-text-muted">
          Discovery refreshes the conversations available to this connection.
        </span>
      </div>
      {discover.isError ? (
        <p className="m-0 text-sm text-danger">{discover.error.message}</p>
      ) : null}
      {discover.isSuccess ? (
        <p className="m-0 text-sm text-status-ready">
          Conversations discovered. Continue to choose access.
        </p>
      ) : null}
    </div>
  );
}
