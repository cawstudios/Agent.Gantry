import { readEnvFile } from './env/file.js';
import { ensureRuntimeLayout, envFilePath } from './settings/runtime-home.js';
import {
  ensureRuntimeSettings,
  validateRuntimeSettings,
} from './settings/runtime-settings.js';
import {
  inspectOnecliPersistenceReadiness,
  ONECLI_SECRET_ENCRYPTION_KEY_ENV,
} from '../infrastructure/onecli/persistence.js';
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
  if (storageReadiness.status === 'fail') {
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

  const settings = ensureRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const onecliPostgres = settings.credentialBroker.onecli.postgres;
  const postgres = settings.storage.postgres;
  const onecliReadiness = await inspectOnecliPersistenceReadiness({
    postgresUrl:
      env[onecliPostgres.urlEnv]?.trim() ||
      process.env[onecliPostgres.urlEnv]?.trim() ||
      '',
    schema: onecliPostgres.schema,
    secretEncryptionKey:
      env[ONECLI_SECRET_ENCRYPTION_KEY_ENV]?.trim() ||
      process.env[ONECLI_SECRET_ENCRYPTION_KEY_ENV]?.trim() ||
      '',
    myclawPostgresUrl:
      env[postgres.urlEnv]?.trim() ||
      process.env[postgres.urlEnv]?.trim() ||
      '',
    myclawSchema: postgres.schema,
  });
  if (onecliReadiness.status !== 'fail') {
    return { ok: true };
  }

  return {
    ok: false,
    failure: {
      summary: onecliReadiness.message,
      details: [
        ...(onecliReadiness.details || []),
        ...(onecliReadiness.nextAction
          ? [`Next action: ${onecliReadiness.nextAction}`]
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
