import { ensureRuntimeLayout } from './settings/runtime-home.js';
import { validateRuntimeSettings } from './settings/runtime-settings.js';
import { inspectRuntimeStorageReadiness } from '../infrastructure/postgres/storage-readiness.js';

export interface RuntimePreflightFailure {
  summary: string;
  details: string[];
}

export interface RuntimePreflightResult {
  ok: boolean;
  failure?: RuntimePreflightFailure;
}

export function validateRuntimePreflight(
  runtimeHome: string,
): RuntimePreflightResult {
  ensureRuntimeLayout(runtimeHome);
  const settingsValidation = validateRuntimeSettings(runtimeHome);
  if (!settingsValidation.ok && settingsValidation.failure) {
    return {
      ok: false,
      failure: settingsValidation.failure,
    };
  }

  return { ok: true };
}

export async function validateRuntimePreflightWithStorage(
  runtimeHome: string,
): Promise<RuntimePreflightResult> {
  const base = validateRuntimePreflight(runtimeHome);
  if (!base.ok) {
    return base;
  }

  const storageReadiness = await inspectRuntimeStorageReadiness(runtimeHome);
  if (storageReadiness.status !== 'fail') {
    return { ok: true };
  }

  return {
    ok: false,
    failure: {
      summary: storageReadiness.message,
      details: [
        ...(storageReadiness.details || []),
        ...(storageReadiness.nextAction
          ? [`Next action: ${storageReadiness.nextAction}`]
          : []),
      ],
    },
  };
}

export function formatRuntimePreflightFailure(
  failure: RuntimePreflightFailure,
): string {
  return [failure.summary, ...failure.details.map((line) => `- ${line}`)].join(
    '\n',
  );
}