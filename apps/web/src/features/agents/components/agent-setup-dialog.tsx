import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { useRuntimeConnection } from '../../../lib/api/runtime-connection';
import { Button } from '../../../ui/primitives/button';
import { IconButton } from '../../../ui/primitives/icon-button';
import { TextField } from '../../../ui/compositions/text-field';
import { agentQueryKeys } from '../agents-queries';

const draftSchema = z.object({ agentId: z.string() });
const persistedDraftSchema = draftSchema.extend({
  name: z.string(),
  purpose: z.string().nullable(),
  version: z.number(),
  modelAlias: z.string().nullable(),
  currentStage: z.enum([
    'agent',
    'model',
    'connection',
    'conversation',
    'profile',
    'review',
  ]),
  connection: z.record(z.string(), z.unknown()).nullable(),
});
const providerAccountsSchema = z.object({
  providerAccounts: z.array(
    z.object({ id: z.string(), label: z.string(), providerId: z.string() }),
  ),
});

export function AgentSetupDialog({
  open,
  setupId,
  onOpenChange,
}: {
  open: boolean;
  setupId?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [draftId, setDraftId] = useState<string>();
  const [version, setVersion] = useState<number>();
  const [modelAlias, setModelAlias] = useState('');
  const [stage, setStage] = useState<'agent' | 'model' | 'connection'>('agent');
  const [providerAccountId, setProviderAccountId] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);

  const dirty = Boolean(name.trim() || purpose.trim());
  const providerAccounts = useQuery({
    queryKey: ['agent-setup', 'provider-accounts'],
    enabled: stage === 'connection' && Boolean(connection.transport),
    queryFn: () =>
      connection.transport!.request({
        path: '/provider-accounts',
        schema: providerAccountsSchema,
      }),
  });

  useEffect(() => {
    if (!open || !setupId || setupId === 'new' || !connection.transport) return;
    void connection.transport
      .request({
        path: `/agent-setups/${encodeURIComponent(setupId)}`,
        schema: persistedDraftSchema,
      })
      .then((draft) => {
        setDraftId(draft.agentId);
        setVersion(draft.version);
        setName(draft.name);
        setPurpose(draft.purpose ?? '');
        setModelAlias(draft.modelAlias ?? '');
        setStage(draft.currentStage === 'agent' ? 'agent' : 'model');
      });
  }, [connection.transport, open, setupId]);

  function requestClose() {
    if (dirty && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    reset();
    onOpenChange(false);
  }

  async function saveDraft() {
    if (!connection.transport || !name.trim()) return;
    setSaving(true);
    try {
      const result = draftId
        ? await connection.transport.request({
            path: `/agent-setups/${encodeURIComponent(draftId)}`,
            method: 'PATCH',
            body: { step: 'agent', expectedVersion: version, name, purpose },
            schema: persistedDraftSchema,
          })
        : await connection.transport.request({
            path: '/agent-setups',
            method: 'POST',
            body: { appId: 'default', name, purpose: purpose || undefined },
            schema: persistedDraftSchema,
          });
      setDraftId(result.agentId);
      if ('version' in result && typeof result.version === 'number') {
        setVersion(result.version);
      }
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list() });
      if (confirmClose) {
        reset();
        onOpenChange(false);
      }
    } finally {
      setSaving(false);
    }
    await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list() });
  }

  async function saveModel() {
    if (!connection.transport || !draftId || !version || !modelAlias.trim())
      return;
    setSaving(true);
    try {
      const result = await connection.transport.request({
        path: `/agent-setups/${encodeURIComponent(draftId)}`,
        method: 'PATCH',
        body: { step: 'model', expectedVersion: version, modelAlias },
        schema: persistedDraftSchema,
      });
      setVersion(result.version);
    } finally {
      setSaving(false);
    }
  }

  async function saveConnection() {
    if (!connection.transport || !draftId || !version || !providerAccountId)
      return;
    setSaving(true);
    try {
      const result = await connection.transport.request({
        path: `/agent-setups/${encodeURIComponent(draftId)}`,
        method: 'PATCH',
        body: {
          step: 'connection',
          expectedVersion: version,
          connection: { providerAccountId },
        },
        schema: persistedDraftSchema,
      });
      setVersion(result.version);
    } finally {
      setSaving(false);
    }
  }

  async function discardDraft() {
    if (draftId && connection.transport) {
      await connection.transport.request({
        path: `/agent-setups/${encodeURIComponent(draftId)}`,
        method: 'DELETE',
        schema: z.object({ discarded: z.literal(true), agentId: z.string() }),
      });
    }
    reset();
    onOpenChange(false);
  }

  function reset() {
    setName('');
    setPurpose('');
    setDraftId(undefined);
    setVersion(undefined);
    setModelAlias('');
    setStage('agent');
    setProviderAccountId('');
    setConfirmClose(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-strong bg-surface p-5 shadow-popover">
          {confirmClose ? (
            <div className="grid gap-5">
              <div>
                <Dialog.Title className="m-0 text-base font-semibold text-text">
                  Leave agent setup?
                </Dialog.Title>
                <Dialog.Description className="mt-1.5 mb-0 text-sm text-text-secondary">
                  Choose whether to save this agent as a draft or discard the
                  draft and its setup-only resources.
                </Dialog.Description>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button onClick={() => setConfirmClose(false)}>
                  Continue setup
                </Button>
                <Button variant="danger" onClick={() => void discardDraft()}>
                  Discard draft
                </Button>
                <Button
                  disabled={!name.trim() || saving}
                  variant="primary"
                  onClick={() => void saveDraft()}
                >
                  {saving ? 'Saving…' : 'Save draft & close'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="m-0 text-base font-semibold text-text">
                    Create agent
                  </Dialog.Title>
                  <Dialog.Description className="mt-1.5 mb-0 text-sm text-text-secondary">
                    Start with an identity. You can complete model, channel,
                    conversation, and profile setup next.
                  </Dialog.Description>
                </div>
                <IconButton
                  aria-label="Close"
                  onClick={requestClose}
                  title="Close"
                >
                  <X size={17} aria-hidden="true" />
                </IconButton>
              </div>
              <div className="flex gap-2 text-xs font-semibold text-text-secondary">
                <span className={stage === 'agent' ? 'text-text' : ''}>
                  1. Agent
                </span>
                <span>2. Model</span>
                <span>3. Connection</span>
                <span>4. Conversation</span>
                <span>5. Profile</span>
                <span>6. Review</span>
              </div>
              {stage === 'agent' ? (
                <>
                  <TextField
                    id="setup-agent-name"
                    label="Agent name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                  <label className="grid gap-1.5 text-xs font-semibold text-text">
                    Purpose
                    <textarea
                      className="min-h-24 resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] font-normal text-text"
                      value={purpose}
                      onChange={(event) => setPurpose(event.target.value)}
                    />
                  </label>
                  <div className="flex justify-end gap-2">
                    <Button onClick={requestClose}>Cancel</Button>
                    <Button
                      disabled={!name.trim() || saving}
                      variant="primary"
                      onClick={() => void saveDraft()}
                    >
                      {draftId
                        ? 'Draft saved'
                        : saving
                          ? 'Saving…'
                          : 'Save draft'}
                    </Button>
                    {draftId ? (
                      <Button
                        variant="primary"
                        onClick={() => setStage('model')}
                      >
                        Continue
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : stage === 'model' ? (
                <>
                  <TextField
                    id="setup-model-alias"
                    label="Model alias"
                    placeholder="e.g. sonnet"
                    value={modelAlias}
                    onChange={(event) => setModelAlias(event.target.value)}
                    required
                  />
                  <div className="flex justify-between gap-2">
                    <Button onClick={() => setStage('agent')}>Back</Button>
                    <Button
                      disabled={!modelAlias.trim() || saving}
                      variant="primary"
                      onClick={() => void saveModel()}
                    >
                      {saving ? 'Saving…' : 'Save model'}
                    </Button>
                    <Button
                      disabled={!modelAlias.trim()}
                      variant="primary"
                      onClick={() => setStage('connection')}
                    >
                      Continue
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <label className="grid gap-1.5 text-xs font-semibold text-text">
                    Provider connection
                    <select
                      className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
                      value={providerAccountId}
                      onChange={(event) =>
                        setProviderAccountId(event.target.value)
                      }
                    >
                      <option value="">Select a connection</option>
                      {providerAccounts.data?.providerAccounts.map(
                        (account) => (
                          <option key={account.id} value={account.id}>
                            {account.label} — {account.providerId}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <div className="flex justify-between gap-2">
                    <Button onClick={() => setStage('model')}>Back</Button>
                    <Button
                      disabled={!providerAccountId || saving}
                      variant="primary"
                      onClick={() => void saveConnection()}
                    >
                      {saving ? 'Saving…' : 'Save connection'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
