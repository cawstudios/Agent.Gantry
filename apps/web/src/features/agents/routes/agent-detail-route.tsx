import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Pause, Pencil, Play, Save, SearchX, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useRuntimeConnection } from '../../../lib/api/runtime-connection';
import { RuntimeApiError } from '../../../lib/api/runtime-transport';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import {
  IdentityPanel,
  ProfilePanel,
  ProtectedPanel,
  RuntimePanel,
  type AgentHarness,
} from '../components/agent-detail-panels';
import {
  loadAgent,
  loadAgentSoul,
  updateAgent,
  updateAgentSoul,
} from '../agents-api';
import { agentQueryKeys } from '../agents-queries';

export function AgentDetailRoute() {
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [showProtected, setShowProtected] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [agentHarness, setAgentHarness] = useState<AgentHarness>('auto');
  const [soulContent, setSoulContent] = useState('');
  const {
    data: agent,
    isPending,
    isError,
  } = useQuery({
    queryKey: [...agentQueryKeys.list(), agentId],
    enabled: Boolean(connection.transport),
    queryFn: () => loadAgent(connection.transport!, agentId),
  });
  const soul = useQuery({
    queryKey: [...agentQueryKeys.list(), agentId, 'soul'],
    enabled: Boolean(connection.transport && agent),
    queryFn: () => loadAgentSoul(connection.transport!, agentId),
  });

  useEffect(() => {
    if (!agent) return;
    setName(agent.name);
    setDescription(agent.description ?? '');
    setStatus(agent.status);
    setAgentHarness(agent.agentHarness);
  }, [agent]);
  useEffect(() => {
    if (soul.data) setSoulContent(soul.data.content);
  }, [soul.data]);

  const saveAgent = useMutation({
    mutationFn: () =>
      updateAgent(connection.transport!, agentId, {
        name,
        description,
        status,
        agentHarness,
      }),
    onSuccess: async () => {
      await invalidateAgent(queryClient, agentId);
    },
  });
  const saveSoul = useMutation({
    mutationFn: () =>
      updateAgentSoul(connection.transport!, agentId, {
        content: soulContent,
        expectedVersion: soul.data!.version,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...agentQueryKeys.list(), agentId, 'soul'],
      });
    },
  });
  const toggle = useMutation({
    mutationFn: () =>
      updateAgent(connection.transport!, agentId, {
        status: agent?.status === 'active' ? 'disabled' : 'active',
      }),
    onSuccess: async () => {
      await invalidateAgent(queryClient, agentId);
    },
  });

  if (isPending) return <LoadingState />;
  if (isError || !agent) return <NotFoundState />;

  const discardEdits = () => {
    setName(agent.name);
    setDescription(agent.description ?? '');
    setStatus(agent.status);
    setAgentHarness(agent.agentHarness);
    setSoulContent(soul.data?.content ?? '');
    setIsEditing(false);
  };
  const saveAll = async () => {
    await saveAgent.mutateAsync();
    if (soul.data && soulContent !== soul.data.content)
      await saveSoul.mutateAsync();
    setIsEditing(false);
  };
  const pause = agent.status === 'active';
  const error = mutationError(saveAgent.error) ?? mutationError(saveSoul.error);

  return (
    <div className="mx-auto grid w-full max-w-[960px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        to="/agents"
        search={{
          q: '',
          status: 'all',
          model: 'all',
          page: 1,
          sort: 'name',
          desc: false,
          setup: undefined,
        }}
      >
        <ArrowLeft size={15} />
        Agents
      </Link>
      <PageHeader
        eyebrow="Agent administration"
        title={agent.name}
        description={agent.description ?? 'No purpose has been set.'}
        action={
          <div className="flex flex-wrap justify-end gap-2">
            <StatusBadge status={agent.status} />
            {isEditing ? (
              <>
                <Button variant="secondary" onClick={discardEdits}>
                  <X size={15} /> Cancel
                </Button>
                <Button
                  disabled={
                    !name.trim() || saveAgent.isPending || saveSoul.isPending
                  }
                  variant="primary"
                  onClick={() => void saveAll()}
                >
                  <Save size={15} />
                  {saveAgent.isPending || saveSoul.isPending
                    ? 'Saving…'
                    : 'Save changes'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={() => toggle.mutate()}>
                  {pause ? <Pause size={15} /> : <Play size={15} />}
                  {pause ? 'Pause agent' : 'Resume agent'}
                </Button>
                <Button variant="primary" onClick={() => setIsEditing(true)}>
                  <Pencil size={15} /> Edit
                </Button>
              </>
            )}
          </div>
        }
      />
      {error ? (
        <p className="m-0 rounded-md border border-danger bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <IdentityPanel
        editing={isEditing}
        name={name}
        description={description}
        onNameChange={setName}
        onDescriptionChange={setDescription}
      />
      <RuntimePanel
        editing={isEditing}
        status={status}
        harness={agentHarness}
        createdAt={agent.createdAt}
        updatedAt={agent.updatedAt}
        onStatusChange={setStatus}
        onHarnessChange={setAgentHarness}
      />
      <ProfilePanel
        editing={isEditing}
        content={soulContent}
        isLoading={soul.isPending}
        error={soul.isError ? 'SOUL.md could not be loaded.' : undefined}
        onChange={setSoulContent}
      />
      <ProtectedPanel
        agentId={agent.id}
        profilePath={soul.data?.path ?? 'SOUL.md'}
        revealed={showProtected}
        onRevealToggle={() => setShowProtected((value) => !value)}
      />
    </div>
  );
}

function LoadingState() {
  return (
    <PageState
      kind="loading"
      icon={<SearchX size={18} />}
      title="Loading agent…"
      description="Fetching the current agent configuration."
    />
  );
}

function NotFoundState() {
  return (
    <PageState
      kind="empty"
      icon={<SearchX size={18} />}
      title="Agent not found"
      description="This agent may have been removed or is unavailable."
    />
  );
}

function mutationError(error: unknown) {
  return error instanceof RuntimeApiError ? error.message : undefined;
}

async function invalidateAgent(
  queryClient: ReturnType<typeof useQueryClient>,
  agentId: string,
) {
  await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list() });
  await queryClient.invalidateQueries({
    queryKey: [...agentQueryKeys.list(), agentId],
  });
}
