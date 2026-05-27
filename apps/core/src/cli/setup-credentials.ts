import * as p from '@clack/prompts';

import type { HostCredentialMode } from '../config/credentials/mode.js';

export interface CredentialSetupDraft {
  credentialMode: HostCredentialMode;
  postgresSetupKind?: 'local' | 'hosted' | 'existing';
}

export type CredentialStepAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'resume' }
  | { type: 'cancel' };

export async function verifyModelAccess(
  _url?: string,
): Promise<{ ok: boolean; message: string; nextAction?: string }> {
  return {
    ok: true,
    message:
      'Gantry Model Gateway credentials are stored in Postgres and validated during model preflight.',
  };
}

export async function runCredentialsStep(
  draft: CredentialSetupDraft,
): Promise<CredentialStepAction> {
  draft.credentialMode = 'gantry';
  p.note(
    [
      'Gantry Model Gateway gives agents brokered access to model providers.',
      'Claude/OpenRouter credentials are added once with `gantry credentials model set <provider>` and apply to agents, subagents, memory runs, and scheduled jobs.',
      'The agent runner receives a loopback gateway token, not raw provider keys.',
      'Channel, Postgres, and runtime-owned secrets still stay in runtime .env.',
    ].join('\n'),
    'Model Access',
  );
  return { type: 'next' };
}
