import { getChannelProvider } from '../../channels/provider-registry.js';
import {
  ONECLI_SECRET_ENCRYPTION_KEY_ENV,
  validateSharedPostgresDatabase,
  validateOnecliDatabaseUrl,
  validateOnecliSecretEncryptionKey,
} from '../../adapters/credentials/onecli/local/persistence.js';
import { validatePostgresConnectionUrl } from '../../infrastructure/postgres/url.js';
import { isValidGroupFolder } from '../../platform/group-folder-rules.js';
import { readEnvFile } from '../env/file.js';
import { resolveHostCredentialMode } from '../credentials/mode.js';
import { validateOnecliUrl } from '../../adapters/credentials/onecli/policy.js';
import { envFilePath, settingsFilePath } from './runtime-home.js';
import type {
  RuntimeSettings,
  RuntimeSettingsValidationResult,
} from './runtime-settings-types.js';

export function validateLoadedRuntimeSettings(
  runtimeHome: string,
  settings: RuntimeSettings,
): RuntimeSettingsValidationResult {
  const details: string[] = [];

  const env = readEnvFile(envFilePath(runtimeHome));
  const credentialMode = resolveHostCredentialMode(
    env.MYCLAW_CREDENTIAL_MODE || process.env.MYCLAW_CREDENTIAL_MODE,
  );
  const postgresUrlEnv = settings.storage.postgres.urlEnv;
  const postgresUrl =
    env[postgresUrlEnv]?.trim() || process.env[postgresUrlEnv]?.trim() || '';
  if (!postgresUrl) {
    details.push(`${postgresUrlEnv} is required for runtime storage.`);
  } else {
    try {
      validatePostgresConnectionUrl(postgresUrl, {
        allowLocalhost: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      details.push(`${postgresUrlEnv} is invalid: ${message}`);
    }
  }

  const onecliDatabaseUrlEnv = settings.credentialBroker.onecli.postgres.urlEnv;
  const onecliDatabaseUrl =
    env[onecliDatabaseUrlEnv]?.trim() ||
    process.env[onecliDatabaseUrlEnv]?.trim() ||
    '';
  if (!onecliDatabaseUrl && credentialMode === 'onecli') {
    details.push(
      `${onecliDatabaseUrlEnv} is required for OneCLI broker persistence.`,
    );
  } else if (onecliDatabaseUrl && credentialMode === 'onecli') {
    try {
      validatePostgresConnectionUrl(onecliDatabaseUrl, {
        allowLocalhost: true,
      });
      const onecliValidation = validateOnecliDatabaseUrl({
        postgresUrl: onecliDatabaseUrl,
        schema: settings.credentialBroker.onecli.postgres.schema,
      });
      if (!onecliValidation.ok) {
        details.push(onecliValidation.message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      details.push(`${onecliDatabaseUrlEnv} is invalid: ${message}`);
    }
  }
  if (postgresUrl && onecliDatabaseUrl && credentialMode === 'onecli') {
    try {
      const sharedDatabase = validateSharedPostgresDatabase({
        myclawPostgresUrl: postgresUrl,
        onecliPostgresUrl: onecliDatabaseUrl,
      });
      if (!sharedDatabase.ok) {
        details.push(sharedDatabase.message);
      }
      const myclawUser = new URL(postgresUrl).username;
      const onecliUser = new URL(onecliDatabaseUrl).username;
      if (myclawUser && onecliUser && myclawUser === onecliUser) {
        details.push(
          'MYCLAW_DATABASE_URL and ONECLI_DATABASE_URL must use different Postgres roles.',
        );
      }
    } catch {
      // URL validity is reported by the concrete validators above.
    }
  }
  const onecliSecret =
    env[ONECLI_SECRET_ENCRYPTION_KEY_ENV]?.trim() ||
    process.env[ONECLI_SECRET_ENCRYPTION_KEY_ENV]?.trim();
  if (credentialMode === 'onecli') {
    const secretValidation = validateOnecliSecretEncryptionKey(onecliSecret);
    if (!secretValidation.ok) {
      details.push(secretValidation.message);
    }
  }

  const onecliUrl =
    env.ONECLI_URL?.trim() || process.env.ONECLI_URL?.trim() || '';
  if (!onecliUrl && credentialMode === 'onecli') {
    details.push('ONECLI_URL is required for OneCLI broker access.');
  } else if (onecliUrl && credentialMode === 'onecli') {
    const onecliUrlValidation = validateOnecliUrl(onecliUrl);
    if (!onecliUrlValidation.ok) {
      details.push(onecliUrlValidation.error || 'ONECLI_URL is invalid.');
    }
  }

  const enabledChannelIds = Object.entries(settings.channels)
    .filter(([, channel]) => channel.enabled)
    .map(([channelId]) => channelId);

  for (const channelId of enabledChannelIds) {
    const provider = getChannelProvider(channelId);
    if (!provider) {
      details.push(
        `channels.${channelId}.enabled is true but no provider is registered for '${channelId}'.`,
      );
      continue;
    }

    for (const envKey of provider.setup.envKeys) {
      if (!env[envKey]?.trim() && !process.env[envKey]?.trim()) {
        details.push(
          `${envKey} is required when channel '${provider.id}' is enabled.`,
        );
      }
    }

    const channelSettings = settings.channels[provider.id];
    for (const folder of Object.keys(channelSettings.senderAllowlist.agents)) {
      if (!isValidGroupFolder(folder)) {
        details.push(
          `channels.${provider.id}.sender_allowlist.agents.${folder} is not a valid agent folder name.`,
        );
      }
    }
  }

  if (
    settings.memory.embeddings.enabled &&
    settings.memory.embeddings.provider === 'disabled'
  ) {
    details.push(
      'memory.embeddings.provider cannot be disabled when memory.embeddings.enabled is true.',
    );
  }
  if (settings.memory.dreaming.enabled && !settings.memory.enabled) {
    details.push('memory.dreaming.enabled requires memory.enabled=true.');
  }

  if (details.length > 0) {
    return {
      ok: false,
      settings,
      failure: {
        summary: 'settings file is invalid for the current runtime',
        details,
      },
    };
  }

  return { ok: true, settings };
}

export function runtimeSettingsValidationError(
  runtimeHome: string,
  err: unknown,
): RuntimeSettingsValidationResult {
  return {
    ok: false,
    failure: {
      summary: 'settings file is invalid',
      details: [
        `File: ${settingsFilePath(runtimeHome)}`,
        err instanceof Error ? err.message : String(err),
      ],
    },
  };
}
