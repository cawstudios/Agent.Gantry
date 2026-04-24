import * as p from '@clack/prompts';
import { OneCLI } from '@onecli-sh/sdk';

import type { HostCredentialMode } from '../config/credentials/mode.js';
import { validateOnecliUrl } from '../infrastructure/onecli/policy.js';

export interface CredentialSetupDraft {
  credentialMode: HostCredentialMode;
  onecliUrl: string;
}

export type CredentialStepAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'resume' }
  | { type: 'cancel' };

function isInputFlowControl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === '/back' ||
    normalized === '/resume' ||
    normalized === '/cancel'
  );
}

function parseInputFlowControl(value: unknown): CredentialStepAction | null {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === '/back') return { type: 'back' };
  if (normalized === '/resume') return { type: 'resume' };
  if (normalized === '/cancel') return { type: 'cancel' };
  return null;
}

async function validateOneCLIReachability(
  onecliUrl: string,
): Promise<{ ok: boolean; message: string }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const urlValidation = validateOnecliUrl(onecliUrl);
    if (!urlValidation.ok || !urlValidation.normalizedUrl) {
      return {
        ok: false,
        message: urlValidation.error || 'Invalid OneCLI URL.',
      };
    }
    const client = new OneCLI({ url: urlValidation.normalizedUrl });
    await Promise.race([
      client.getContainerConfig(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('connection timed out after 8 seconds'));
        }, 8_000);
      }),
    ]);
    return {
      ok: true,
      message: `Connected to OneCLI at ${urlValidation.normalizedUrl}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `OneCLI check failed for ${onecliUrl}: ${message}`,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function runCredentialsStep(
  draft: CredentialSetupDraft,
): Promise<CredentialStepAction> {
  p.note(
    [
      'Host-agent credentials are brokered through OneCLI.',
      'The agent runner receives broker/proxy config only; raw Claude credentials are not persisted in runtime .env.',
      'Channel, Postgres, and runtime-owned secrets still live in runtime .env.',
    ].join('\n'),
    'Agent Credentials',
  );

  while (true) {
    draft.credentialMode = 'onecli';

    const defaultOnecliUrl = draft.onecliUrl || 'http://localhost:10254';
    const onecliUrlInput = await p.text({
      message: 'Enter OneCLI gateway URL (/back, /resume, /cancel)',
      placeholder: 'http://localhost:10254',
      defaultValue: defaultOnecliUrl,
      validate: (input) => {
        const trimmed = String(input ?? '').trim();
        if (isInputFlowControl(trimmed)) return undefined;
        if (!trimmed && defaultOnecliUrl) return undefined;
        if (!trimmed) {
          return 'OneCLI URL is required for this mode.';
        }
        const result = validateOnecliUrl(trimmed);
        return result.ok ? undefined : result.error;
      },
    });
    if (p.isCancel(onecliUrlInput)) return { type: 'resume' };
    const onecliControl = parseInputFlowControl(onecliUrlInput);
    if (onecliControl) return onecliControl;
    draft.onecliUrl = String(onecliUrlInput).trim() || defaultOnecliUrl;

    const spinner = p.spinner();
    spinner.start('Validating OneCLI connectivity...');
    const check = await validateOneCLIReachability(draft.onecliUrl);
    spinner.stop(
      check.ok ? 'OneCLI validation passed' : 'OneCLI validation failed',
    );

    if (check.ok) {
      p.note(
        `${check.message}\nCredential mode set to onecli. Local Claude credentials will be removed from runtime .env.`,
        'Agent Credentials',
      );
      return { type: 'next' };
    }

    p.note(
      `${check.message}\nNext action: confirm OneCLI URL and gateway availability.`,
      'OneCLI Validation',
    );

    const followUp = await p.select({
      message: 'OneCLI-only mode requires a reachable OneCLI gateway.',
      options: [
        {
          value: 'retry',
          label: 'Retry OneCLI check (Recommended)',
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
    });
    if (p.isCancel(followUp)) return { type: 'resume' };
    if (followUp === 'retry') {
      continue;
    }
    if (followUp === 'back') return { type: 'back' };
    if (followUp === 'resume') return { type: 'resume' };
    return { type: 'cancel' };
  }
}