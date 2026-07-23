import { Eye, EyeOff } from 'lucide-react';

import { Panel } from '../../../ui/compositions/panel';
import { TextField } from '../../../ui/compositions/text-field';
import { IconButton } from '../../../ui/primitives/icon-button';

export type AgentHarness = 'auto' | 'anthropic_sdk' | 'deepagents';

export function IdentityPanel(props: {
  editing: boolean;
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
}) {
  return (
    <Panel
      title="Identity"
      description="Name and purpose shown to people using this agent."
    >
      {props.editing ? (
        <div className="grid gap-4 p-5">
          <TextField
            id="agent-name"
            label="Agent name"
            required
            value={props.name}
            onChange={(event) => props.onNameChange(event.target.value)}
          />
          <TextArea
            label="Purpose"
            value={props.description}
            onChange={props.onDescriptionChange}
          />
        </div>
      ) : (
        <ReadOnlyGrid
          values={[
            ['Agent name', props.name],
            ['Purpose', props.description || 'Not set'],
          ]}
        />
      )}
    </Panel>
  );
}

export function RuntimePanel(props: {
  editing: boolean;
  status: 'active' | 'disabled';
  harness: AgentHarness;
  createdAt: string;
  updatedAt: string;
  onStatusChange: (value: 'active' | 'disabled') => void;
  onHarnessChange: (value: AgentHarness) => void;
}) {
  return (
    <Panel
      title="Runtime"
      description="How this agent runs. Changes take effect after saving."
    >
      {props.editing ? (
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <SelectField
            label="Status"
            value={props.status}
            onChange={(value) =>
              props.onStatusChange(value as 'active' | 'disabled')
            }
            options={[
              ['active', 'Active'],
              ['disabled', 'Paused'],
            ]}
          />
          <SelectField
            label="Agent harness"
            value={props.harness}
            onChange={(value) => props.onHarnessChange(value as AgentHarness)}
            options={[
              ['auto', 'Auto'],
              ['anthropic_sdk', 'Anthropic SDK'],
              ['deepagents', 'DeepAgents'],
            ]}
          />
        </div>
      ) : (
        <ReadOnlyGrid
          values={[
            ['Status', props.status === 'active' ? 'Active' : 'Paused'],
            ['Agent harness', harnessLabel(props.harness)],
            ['Created', dateLabel(props.createdAt)],
            ['Last updated', dateLabel(props.updatedAt)],
          ]}
        />
      )}
    </Panel>
  );
}

export function ProfilePanel(props: {
  editing: boolean;
  content: string;
  isLoading: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Panel
      title="SOUL.md"
      description="This agent’s persona, voice, boundaries, and working style."
    >
      {props.isLoading ? (
        <p className="m-0 p-5 text-sm text-text-secondary">Loading profile…</p>
      ) : props.error ? (
        <p className="m-0 p-5 text-sm text-danger">{props.error}</p>
      ) : props.editing ? (
        <div className="p-5">
          <TextArea
            label="SOUL.md"
            rows={18}
            value={props.content}
            onChange={props.onChange}
            hint="This changes only this agent’s profile."
          />
        </div>
      ) : (
        <textarea
          aria-label="SOUL.md"
          className="m-0 min-h-72 w-full resize-y border-0 bg-surface p-5 font-mono text-xs leading-6 text-text disabled:cursor-not-allowed"
          disabled
          value={props.content || 'No SOUL.md content has been set.'}
        />
      )}
    </Panel>
  );
}

export function ProtectedPanel(props: {
  agentId: string;
  profilePath: string;
  revealed: boolean;
  onRevealToggle: () => void;
}) {
  const value = (source: string) => (props.revealed ? source : '*****');
  return (
    <Panel
      title="Protected details"
      description="Identifiers are hidden by default. Credential values are never sent to the browser."
    >
      <div className="grid gap-4 p-5 sm:grid-cols-[1fr_auto] sm:items-end">
        <ReadOnlyGrid
          values={[
            ['Agent ID', value(props.agentId)],
            ['Profile file', value(props.profilePath)],
            [
              'Credentials',
              props.revealed ? 'Stored securely (not revealable)' : '*****',
            ],
          ]}
        />
        <IconButton
          aria-label={
            props.revealed ? 'Hide protected details' : 'Show protected details'
          }
          title={
            props.revealed ? 'Hide protected details' : 'Show protected details'
          }
          onClick={props.onRevealToggle}
        >
          {props.revealed ? <EyeOff size={16} /> : <Eye size={16} />}
        </IconButton>
      </div>
    </Panel>
  );
}

function ReadOnlyGrid({ values }: { values: Array<[string, string]> }) {
  return (
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {values.map(([label, value]) => (
        <div key={label} className="grid min-w-0 gap-1.5">
          <dt className="text-xs font-semibold text-text-secondary">{label}</dt>
          <dd className="m-0">
            <input
              aria-label={label}
              className="h-9 w-full rounded-md border border-border bg-surface-muted px-3 text-[13px] text-text-secondary disabled:cursor-not-allowed"
              disabled
              value={value}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TextArea({
  label,
  value,
  onChange,
  rows = 5,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-semibold text-text">{label}</span>
      <textarea
        className="w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] leading-5 text-text"
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <span className="text-xs text-text-muted">{hint}</span> : null}
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-semibold text-text">{label}</span>
      <select
        className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] text-text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function harnessLabel(value: AgentHarness) {
  return value === 'anthropic_sdk'
    ? 'Anthropic SDK'
    : value === 'deepagents'
      ? 'DeepAgents'
      : 'Auto';
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
