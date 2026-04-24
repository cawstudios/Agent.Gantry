import { getChannelProvider } from '../../channels/provider-registry.js';
import { validatePostgresConnectionUrl } from '../../infrastructure/postgres/url.js';
import { isValidGroupFolder } from '../../platform/group-folder-rules.js';
import { readEnvFile } from '../env/file.js';
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
      if (!env[envKey]?.trim()) {
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