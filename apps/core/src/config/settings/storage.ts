import { readRuntimeStorageSettingsSnapshot } from './runtime-settings.js';
import { envValueDynamic } from '../env/index.js';
import { validatePostgresConnectionUrl } from '../../infrastructure/postgres/url.js';

export interface RuntimeStorageConfig {
  postgresUrlEnv: string;
  postgresUrl: string | null;
  postgresSchema: string;
}

export function resolveRuntimeStorageConfig(
  myclawHome: string,
  _runtimeRoot: string,
): RuntimeStorageConfig {
  let settings;
  try {
    settings = readRuntimeStorageSettingsSnapshot(myclawHome);
  } catch (err) {
    const storageError = err instanceof Error ? err : new Error(String(err));
    throw new Error(
      `Invalid runtime storage settings: ${storageError.message}`,
    );
  }
  const postgresUrlEnv = settings.postgresUrlEnv || 'MYCLAW_DATABASE_URL';
  const postgresUrl = envValueDynamic(postgresUrlEnv).trim() || null;
  if (postgresUrl) {
    try {
      validatePostgresConnectionUrl(postgresUrl, {
        allowLocalhost: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Invalid runtime storage settings: ${postgresUrlEnv} ${message}`,
      );
    }
  }
  return {
    postgresUrlEnv,
    postgresUrl,
    postgresSchema: settings.postgresSchema || 'myclaw',
  };
}
