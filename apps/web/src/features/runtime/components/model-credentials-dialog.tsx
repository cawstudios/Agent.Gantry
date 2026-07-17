import * as Dialog from '@radix-ui/react-dialog';
import { KeyRound, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import { IconButton } from '../../../ui/primitives/icon-button';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import type { ModelCredential } from '../model-api';
import {
  useDisableModelCredential,
  useSaveModelCredential,
} from '../use-model-dashboard';

export function ModelCredentialsDialog({
  credentials,
  open,
  onOpenChange,
}: {
  credentials: ModelCredential[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [providerId, setProviderId] = useState(
    credentials[0]?.providerId ?? '',
  );
  const provider = useMemo(
    () => credentials.find((item) => item.providerId === providerId),
    [credentials, providerId],
  );
  const [authMode, setAuthMode] = useState('');
  const [payload, setPayload] = useState<Record<string, string>>({});
  const save = useSaveModelCredential();
  const disable = useDisableModelCredential();

  useEffect(() => {
    if (!open) return;
    const nextProvider =
      credentials.find((item) => item.providerId === providerId) ??
      credentials[0];
    setProviderId(nextProvider?.providerId ?? '');
    setAuthMode(
      nextProvider?.authMode ?? nextProvider?.credentialModes[0]?.id ?? '',
    );
    setPayload({});
  }, [credentials, open, providerId]);

  const mode = provider?.credentialModes.find((item) => item.id === authMode);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider || !mode) return;
    try {
      await save.mutateAsync({
        providerId: provider.providerId,
        authMode,
        payload,
      });
      onOpenChange(false);
    } catch {
      // TanStack Mutation exposes the sanitized server error in the form.
    } finally {
      setPayload({});
    }
  }

  async function disableProvider() {
    if (!provider?.configured) return;
    const confirmed = window.confirm(
      `Disable ${provider.label ?? provider.providerId} credentials? Model routes using this provider will become unavailable.`,
    );
    if (!confirmed) return;
    try {
      await disable.mutateAsync(provider.providerId);
      setPayload({});
    } catch {
      // TanStack Mutation exposes the sanitized server error in the form.
    }
  }

  function changeProvider(nextProviderId: string) {
    const nextProvider = credentials.find(
      (item) => item.providerId === nextProviderId,
    );
    setProviderId(nextProviderId);
    setAuthMode(
      nextProvider?.authMode ?? nextProvider?.credentialModes[0]?.id ?? '',
    );
    setPayload({});
    save.reset();
    disable.reset();
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setPayload({});
        onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-32px)] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border-strong bg-surface p-5 shadow-popover">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="m-0 flex items-center gap-2 text-base font-semibold text-text">
                <KeyRound size={17} aria-hidden="true" /> Model credentials
              </Dialog.Title>
              <Dialog.Description className="mt-1.5 mb-0 text-sm text-text-secondary">
                Credential values are sent once and are never returned to this
                UI.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <IconButton aria-label="Close" title="Close">
                <X size={17} aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </div>
          {provider ? (
            <form
              className="mt-5 grid gap-4"
              onSubmit={(event) => void submit(event)}
            >
              <label className="grid gap-1.5 text-xs font-semibold text-text">
                Provider
                <select
                  className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
                  value={providerId}
                  onChange={(event) => changeProvider(event.target.value)}
                >
                  {credentials.map((item) => (
                    <option key={item.providerId} value={item.providerId}>
                      {item.label ?? item.providerId}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-muted px-3 py-2.5">
                <span className="text-xs text-text-secondary">
                  {provider.configured
                    ? 'Configured'
                    : 'No credential configured'}
                </span>
                <StatusBadge
                  status={provider.health === 'ready' ? 'ready' : 'attention'}
                />
              </div>
              {provider.credentialModes.length > 1 ? (
                <label className="grid gap-1.5 text-xs font-semibold text-text">
                  Authentication mode
                  <select
                    className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
                    value={authMode}
                    onChange={(event) => {
                      setAuthMode(event.target.value);
                      setPayload({});
                    }}
                  >
                    {provider.credentialModes.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {mode ? (
                <p className="m-0 text-xs leading-5 text-text-secondary">
                  {mode.helpText}
                </p>
              ) : null}
              {mode?.fields.map((field) => (
                <label
                  key={field.name}
                  className="grid gap-1.5 text-xs font-semibold text-text"
                >
                  {field.label}
                  <input
                    autoComplete={field.secret ? 'new-password' : 'off'}
                    className="h-9 rounded-md border border-border-strong bg-surface px-3 font-mono text-[13px] font-normal text-text"
                    required={field.required}
                    type={field.secret ? 'password' : 'text'}
                    value={payload[field.name] ?? ''}
                    onChange={(event) =>
                      setPayload((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
              {save.error || disable.error ? (
                <p className="m-0 text-sm text-danger" role="alert">
                  {(save.error ?? disable.error)?.message}
                </p>
              ) : null}
              <div className="mt-1 flex flex-wrap justify-end gap-2">
                {provider.configured ? (
                  <Button
                    disabled={save.isPending || disable.isPending}
                    onClick={() => void disableProvider()}
                    variant="danger"
                  >
                    Disable
                  </Button>
                ) : null}
                <Button
                  disabled={save.isPending || disable.isPending}
                  type="submit"
                  variant="primary"
                >
                  {save.isPending
                    ? 'Saving...'
                    : provider.configured
                      ? 'Replace credential'
                      : 'Save credential'}
                </Button>
              </div>
            </form>
          ) : (
            <p className="mt-5 mb-0 text-sm text-text-secondary">
              No credential providers are available.
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
