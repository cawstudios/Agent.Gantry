import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  Boxes,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Settings2,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import { useState } from 'react';

import { useRuntimeConnection } from '../../../lib/api/runtime-connection';
import { MetricTile } from '../../../ui/compositions/metric-tile';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { ModelCredentialsDialog } from '../components/model-credentials-dialog';
import { ModelDefaultsDialog } from '../components/model-defaults-dialog';
import { useModelDashboard } from '../use-model-dashboard';

const families = ['all', 'Anthropic', 'OpenAI', 'OpenRouter'] as const;

export function ModelsRoute() {
  const search = useSearch({ from: '/runtime/models' });
  const navigate = useNavigate({ from: '/runtime/models' });
  const connection = useRuntimeConnection();
  const query = useModelDashboard();
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const data = query.data;
  const visible = (data?.models ?? []).filter(
    (model) => search.family === 'all' || model.family === search.family,
  );
  const totalRequests = (data?.models ?? []).reduce(
    (sum, model) => sum + model.requests24h,
    0,
  );
  const readyModels = (data?.models ?? []).filter(
    (model) => model.readiness === 'ready',
  ).length;
  const readyCredentials = (data?.credentials ?? []).filter(
    (credential) => credential.health === 'ready',
  ).length;

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <PageHeader
        eyebrow="Runtime"
        title="Models"
        description="Friendly aliases, harness compatibility, readiness, and usage."
        action={
          data ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setCredentialsOpen(true)}>
                <KeyRound size={16} aria-hidden="true" /> Credentials
              </Button>
              <Button onClick={() => setDefaultsOpen(true)}>
                <Settings2 size={16} aria-hidden="true" /> Defaults
              </Button>
            </div>
          ) : undefined
        }
      />
      {!connection.transport ? (
        <PageState
          description="Start Gantry with local-owner UI linkage to load models and credentials."
          icon={<WifiOff size={18} aria-hidden="true" />}
          kind="offline"
          title="Runtime not connected"
        />
      ) : query.isPending ? (
        <PageState
          description="Loading aliases, defaults, credential readiness, and recent usage."
          icon={
            <LoaderCircle
              className="animate-spin"
              size={18}
              aria-hidden="true"
            />
          }
          kind="loading"
          title="Loading models"
        />
      ) : query.isError ? (
        <PageState
          action={
            <Button onClick={() => void query.refetch()}>
              <RefreshCw size={16} aria-hidden="true" /> Retry
            </Button>
          }
          description={query.error.message}
          icon={<TriangleAlert size={18} aria-hidden="true" />}
          kind="error"
          title="Models could not be loaded"
        />
      ) : data ? (
        <ModelContent
          data={data}
          visible={visible}
          totalRequests={totalRequests}
          readyModels={readyModels}
          readyCredentials={readyCredentials}
          family={search.family}
          onFamilyChange={(family) => void navigate({ search: { family } })}
        />
      ) : null}
      {data ? (
        <>
          <ModelDefaultsDialog
            defaults={data.defaults}
            models={data.models}
            open={defaultsOpen}
            onOpenChange={setDefaultsOpen}
          />
          <ModelCredentialsDialog
            credentials={data.credentials}
            open={credentialsOpen}
            onOpenChange={setCredentialsOpen}
          />
        </>
      ) : null}
    </div>
  );
}

function ModelContent({
  data,
  visible,
  totalRequests,
  readyModels,
  readyCredentials,
  family,
  onFamilyChange,
}: {
  data: NonNullable<ReturnType<typeof useModelDashboard>['data']>;
  visible: NonNullable<ReturnType<typeof useModelDashboard>['data']>['models'];
  totalRequests: number;
  readyModels: number;
  readyCredentials: number;
  family: (typeof families)[number];
  onFamilyChange: (family: (typeof families)[number]) => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile
          label="Aliases"
          value={String(data.models.length)}
          detail={`${readyModels} currently ready`}
        />
        <MetricTile
          label="Requests · 24h"
          value={String(totalRequests)}
          detail="across all aliases"
        />
        <MetricTile
          label="Credentials"
          value={`${readyCredentials}/${data.credentials.length}`}
          detail="providers ready"
        />
      </div>
      <label className="grid max-w-[240px] gap-1.5 text-xs font-semibold text-text">
        Model family
        <select
          className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
          value={family}
          onChange={(event) =>
            onFamilyChange(event.target.value as typeof family)
          }
        >
          {families.map((family) => (
            <option key={family} value={family}>
              {family === 'all' ? 'All families' : family}
            </option>
          ))}
        </select>
      </label>
      <Panel
        title="Model catalog"
        description={`${visible.length} aliases shown`}
        action={<Boxes size={17} aria-hidden="true" />}
      >
        <div className="divide-y divide-border">
          {visible.map((model) => (
            <article
              className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_auto]"
              key={model.alias}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="font-mono text-sm text-text">
                    {model.alias}
                  </strong>
                  <Badge>{model.family}</Badge>
                  {model.experimental ? (
                    <Badge tone="attention">Experimental</Badge>
                  ) : null}
                  <StatusBadge status={model.readiness} />
                </div>
                <p className="mt-1.5 mb-0 text-sm text-text-secondary">
                  {model.displayName}
                </p>
                <p className="mt-3 mb-0 text-xs text-text-secondary">
                  Compatible harnesses
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {model.compatibleHarnesses.map((harness) => (
                    <Badge key={harness}>{harness}</Badge>
                  ))}
                </div>
              </div>
              <dl className="m-0 grid grid-cols-2 gap-5 text-right text-xs">
                <Usage label="Requests" value={String(model.requests24h)} />
                <Usage label="Tokens" value={model.tokens24h} />
              </dl>
            </article>
          ))}
        </div>
      </Panel>
    </>
  );
}

function Usage({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-text-muted">{label}</dt>
      <dd className="mt-1 ml-0 font-mono text-text">{value}</dd>
    </div>
  );
}
