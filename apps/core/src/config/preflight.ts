import { readEnvFile } from './env/file.js';
import { ensureRuntimeLayout, envFilePath } from './settings/runtime-home.js';
import {
  ensureRuntimeSettings,
  saveRuntimeSettings,
  validateRuntimeSettings,
} from './settings/runtime-settings.js';
import { settingsCapabilityIdToToolRule } from './settings/generated-runtime-capability-cleanup.js';
import { SettingsDesiredStateService } from './settings/desired-state-service.js';
import {
  inspectOnecliPersistenceReadiness,
  ONECLI_SECRET_ENCRYPTION_KEY_ENV,
} from '../adapters/credentials/onecli/local/persistence.js';
import { createStorageRuntime } from '../adapters/storage/postgres/factory.js';
import { inspectRuntimeStorageReadiness } from '../adapters/storage/postgres/storage-readiness.js';
import { validateExternalBrokerUrl } from './credentials/broker-url-policy.js';
import { containsGeneratedRuntimeSkillPath } from '../shared/generated-runtime-paths.js';

export interface RuntimePreflightFailure {
  summary: string;
  details: string[];
}

export interface RuntimePreflightResult {
  ok: boolean;
  failure?: RuntimePreflightFailure;
}

export interface RuntimePreflightWithStorageOptions {
  cleanupGeneratedRuntimeSettings?: (
    runtimeHome: string,
  ) => Promise<RuntimePreflightResult>;
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
  options: RuntimePreflightWithStorageOptions = {},
): Promise<RuntimePreflightResult> {
  ensureRuntimeLayout(runtimeHome);
  const storageReadiness = await inspectRuntimeStorageReadiness(runtimeHome, {
    migrate: true,
  });
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

  if (runtimeSettingsHasGeneratedRuntimeCapabilities(runtimeHome)) {
    const cleanup = options.cleanupGeneratedRuntimeSettings
      ? await options.cleanupGeneratedRuntimeSettings(runtimeHome)
      : await cleanupGeneratedRuntimeSettingsWithStorage(runtimeHome);
    if (!cleanup.ok) return cleanup;
  }

  const base = validateRuntimePreflight(runtimeHome);
  if (!base.ok) {
    return base;
  }

  const settings = ensureRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const runtimeSecretsSource: Record<string, string | undefined> = {
    ...env,
    ...process.env,
  };
  const getRuntimeSecret = (envName: string): string =>
    runtimeSecretsSource[envName] || '';
  const credentialMode = settings.credentialBroker.mode;
  if (credentialMode === 'external') {
    try {
      const validation = validateExternalBrokerUrl(
        settings.credentialBroker.external.baseUrl,
        'credential_broker.external.base_url',
      );
      if (!validation.ok || !validation.normalizedUrl) {
        throw new Error(
          validation.error || 'credential_broker.external.base_url is invalid.',
        );
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        failure: {
          summary:
            err instanceof Error
              ? err.message
              : 'External credential broker is not configured.',
          details: [
            'Next action: Set credential_broker.external.base_url in settings.yaml to a broker-safe external credential endpoint.',
          ],
        },
      };
    }
  }
  if (credentialMode !== 'onecli') {
    return { ok: true };
  }
  const onecliPostgres = settings.credentialBroker.onecli.postgres;
  const gantryPostgres = settings.storage.postgres;
  const onecliReadiness = await inspectOnecliPersistenceReadiness({
    postgresUrl: getRuntimeSecret(onecliPostgres.urlEnv),
    schema: onecliPostgres.schema,
    secretEncryptionKey: getRuntimeSecret(ONECLI_SECRET_ENCRYPTION_KEY_ENV),
    gantryPostgresUrl: getRuntimeSecret(gantryPostgres.urlEnv),
    gantrySchema: gantryPostgres.schema,
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

function runtimeSettingsHasGeneratedRuntimeCapabilities(
  runtimeHome: string,
): boolean {
  const settings = ensureRuntimeSettings(runtimeHome);
  return Object.values(settings.agents).some((agent) =>
    agent.capabilities.some((capability) =>
      containsGeneratedRuntimeSkillPath(
        settingsCapabilityIdToToolRule(capability.id),
      ),
    ),
  );
}

export async function cleanupGeneratedRuntimeSettingsWithStorage(
  runtimeHome: string,
): Promise<RuntimePreflightResult> {
  const storage = createStorageRuntime();
  try {
    const settings = ensureRuntimeSettings(runtimeHome);
    const desiredState = new SettingsDesiredStateService({
      ops: storage.ops,
      repositories: storage.repositories,
    });
    const cleanup =
      await desiredState.cleanupGeneratedRuntimeCapabilities(settings);
    if (cleanup.changed) {
      saveRuntimeSettings(runtimeHome, cleanup.settings);
      const reconcile = await desiredState.reconcile(settings);
      if (reconcile.invalidReferences.length > 0) {
        return {
          ok: false,
          failure: {
            summary: 'settings desired state contains invalid references',
            details: reconcile.invalidReferences,
          },
        };
      }
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      failure: {
        summary: 'settings generated runtime capability cleanup failed',
        details: [err instanceof Error ? err.message : String(err)],
      },
    };
  } finally {
    await storage.service.close();
  }
}

export function formatRuntimePreflightFailure(
  failure: RuntimePreflightFailure,
): string {
  return [failure.summary, ...failure.details.map((line) => `- ${line}`)].join(
    '\n',
  );
}
