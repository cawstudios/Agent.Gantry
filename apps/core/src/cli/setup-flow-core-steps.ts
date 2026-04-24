import * as p from '@clack/prompts';

import {
  ensureRuntimeWritable,
  resolveRuntimeHome,
} from '../config/settings/runtime-home.js';
import { validatePostgresConnectionUrl } from '../infrastructure/postgres/url.js';
import {
  CLAUDE_MODEL_PINS,
  DEFAULT_SETUP_MODEL,
  normalizeClaudeModelSelection,
} from '../models/claude-model-registry.js';
import {
  type FlowAction,
  isInputFlowControl,
  parseInputFlowControl,
} from './setup-flow-control.js';
import { chooseProgressAction } from './setup-flow-prompts.js';
import type { SetupDraft } from './setup-flow-state.js';

export async function runWelcomeStep(): Promise<FlowAction> {
  p.note(
    [
      'This setup will connect your first channel and prepare your MyClaw runtime home.',
      'You can go Back, Resume Later, or Cancel until the final create-runtime confirmation.',
    ].join('\n'),
    'Welcome',
  );
  return chooseProgressAction({
    message: 'Start guided setup now?',
    continueLabel: 'Start Setup',
    includeBack: false,
  });
}

export async function runRuntimeHomeStep(
  draft: SetupDraft,
): Promise<{ action: FlowAction; changedHome?: string }> {
  const defaultRuntimeHome = draft.runtimeHome || '~/myclaw';
  const value = await p.text({
    message:
      'Where should MyClaw store runtime data? (/back, /resume, /cancel)',
    placeholder: '~/myclaw',
    defaultValue: defaultRuntimeHome,
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if ((!input || !input.trim()) && !defaultRuntimeHome) {
        return 'Please enter a path (for example: ~/myclaw).';
      }
      return undefined;
    },
  });

  if (p.isCancel(value)) {
    return { action: { type: 'resume' } };
  }
  const control = parseInputFlowControl(value);
  if (control) {
    return { action: control };
  }

  const resolved = resolveRuntimeHome(
    String(value).trim() || defaultRuntimeHome,
  );
  try {
    ensureRuntimeWritable(resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(
      `Cannot write to ${resolved}. Next action: fix permissions or choose another path. (${message})`,
    );
    return { action: { type: 'goto', step: 'runtime_home' } };
  }

  p.note(
    [
      `Runtime home: ${resolved}`,
      'MyClaw will keep .env, settings.yaml, store/, agents/, data/, logs/, and onboarding state here.',
    ].join('\n'),
    'Runtime Home',
  );

  const action = await chooseProgressAction({
    message: 'Use this runtime home?',
    continueLabel: 'Use This Path',
    includeBack: true,
  });
  if (action.type !== 'next') {
    return { action };
  }
  return {
    action,
    changedHome: resolved,
  };
}

export async function runStorageStep(draft: SetupDraft): Promise<FlowAction> {
  p.note(
    [
      'MyClaw stores runtime state in Postgres.',
      'Use local Docker Postgres for development or a remote database with sslmode=require (or stronger).',
    ].join('\n'),
    'Storage',
  );

  const action = await chooseProgressAction({
    message: 'Configure Postgres runtime storage?',
    continueLabel: 'Configure Postgres',
    includeBack: true,
  });
  if (action.type !== 'next') return action;

  p.note(
    [
      'MyClaw requires Postgres with pgvector, a text-search extension, and pg-boss readiness.',
      'Localhost and Docker-local URLs are supported for local development.',
    ].join('\n'),
    'Postgres',
  );

  const url = await p.text({
    message: 'Postgres URL (stored in MYCLAW_DATABASE_URL)',
    placeholder:
      'postgres://user:pass@db.example.com:5432/myclaw?sslmode=require',
    defaultValue: draft.postgresDatabaseUrl,
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if (!trimmed) return 'Postgres URL is required.';
      try {
        validatePostgresConnectionUrl(trimmed, {
          allowLocalhost: true,
        });
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      return undefined;
    },
  });
  if (p.isCancel(url)) return { type: 'resume' };
  const urlControl = parseInputFlowControl(url);
  if (urlControl) return urlControl;
  const normalizedUrl = String(url).trim();
  validatePostgresConnectionUrl(normalizedUrl, {
    allowLocalhost: true,
  });
  draft.postgresDatabaseUrl = normalizedUrl;

  const schema = await p.text({
    message: 'Postgres schema',
    placeholder: 'myclaw',
    defaultValue: draft.postgresSchema || 'myclaw',
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(trimmed)) {
        return 'Use a valid PostgreSQL schema identifier.';
      }
      return undefined;
    },
  });
  if (p.isCancel(schema)) return { type: 'resume' };
  const schemaControl = parseInputFlowControl(schema);
  if (schemaControl) return schemaControl;
  draft.postgresSchema = String(schema).trim();
  return { type: 'next' };
}

export async function runPrerequisitesStep(): Promise<FlowAction> {
  p.note(
    [
      'MyClaw runs as a local host process.',
      'Proceed once Node.js and runtime-home checks are passing.',
    ].join('\n'),
    'Runtime Prerequisites',
  );

  return chooseProgressAction({
    message: 'Continue to provider selection?',
    continueLabel: 'Continue',
    includeBack: true,
  });
}

export async function runChannelStep(draft: SetupDraft): Promise<FlowAction> {
  const value = await p.select({
    message: 'Choose your first channel provider',
    options: [
      {
        value: 'telegram',
        label: 'Telegram (Recommended)',
        hint: 'Bot token from BotFather + chat auto-discovery.',
      },
      {
        value: 'slack',
        label: 'Slack',
        hint: 'Bot token + app token + conversation auto-discovery.',
      },
      {
        value: 'back',
        label: 'Back',
      },
      {
        value: 'resume',
        label: 'Resume Later',
      },
      {
        value: 'cancel',
        label: 'Cancel Setup',
      },
    ],
    initialValue: draft.primaryProvider,
  });

  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume') return { type: 'resume' };
  if (value === 'cancel') return { type: 'cancel' };

  draft.primaryProvider = value === 'slack' ? 'slack' : 'telegram';
  return { type: 'next' };
}

export async function runModelStep(draft: SetupDraft): Promise<FlowAction> {
  const value = await p.select({
    message: 'Choose main model',
    options: [
      {
        value: 'sonnet',
        label: 'Sonnet',
        hint: `Balanced speed/cost/quality. Uses the Claude Code ${CLAUDE_MODEL_PINS.sonnet} family without pinning your setup.`,
      },
      {
        value: 'opus',
        label: 'Opus (Recommended)',
        hint: 'Highest quality for agentic coding. Uses the Claude Code opus alias so your install tracks your account/provider safely.',
      },
      {
        value: 'opusplan',
        label: 'Opus Plan',
        hint: 'Uses Opus for planning and Sonnet for execution.',
      },
      {
        value: 'back',
        label: 'Back',
      },
      {
        value: 'resume',
        label: 'Resume Later',
      },
      {
        value: 'cancel',
        label: 'Cancel Setup',
      },
    ],
    initialValue: draft.selectedModel || DEFAULT_SETUP_MODEL,
  });

  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume' || value === 'cancel') return { type: value };
  draft.selectedModel =
    normalizeClaudeModelSelection(String(value)) || String(value);
  return { type: 'next' };
}