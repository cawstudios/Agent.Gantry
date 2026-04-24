import fs from 'fs';
import path from 'path';
import '../channels/register-builtins.js';
import {
  getChannelProvider,
  listConnectableChannelProviders,
} from '../channels/provider-registry.js';

import { readEnvFile } from '../config/env/file.js';
import {
  assertRuntimeEntryExists,
  getRuntimeEntryPath,
} from '../infrastructure/service/package-paths.js';
import {
  commandExists,
  detectPlatform,
  getNodeMajorVersion,
  getNodeVersion,
  hasSystemdUser,
} from '../infrastructure/service/platform.js';
import {
  envFilePath,
  ensureRuntimeWritable,
} from '../config/settings/runtime-home.js';
import {
  ensureRuntimeSettings,
  RuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { validateTelegramBotToken } from './telegram.js';
import { inspectMemoryHealth } from './memory-health.js';
import { validatePostgresConnectionUrl } from '../infrastructure/postgres/url.js';
import { inspectRuntimeStorageReadiness } from '../infrastructure/postgres/storage-readiness.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  message: string;
  nextAction?: string;
}

export interface DoctorReport {
  ok: boolean;
  blockingFailures: number;
  warnings: number;
  checks: DoctorCheck[];
}

export interface DoctorNetworkOptions {
  validateTelegramToken?: boolean;
  telegramTimeoutMs?: number;
}

function statusLabel(status: DoctorStatus): string {
  if (status === 'pass') return 'PASS';
  if (status === 'warn') return 'WARN';
  return 'FAIL';
}

function add(checks: DoctorCheck[], check: DoctorCheck): void {
  checks.push(check);
}

function addToReport(report: DoctorReport, check: DoctorCheck): DoctorReport {
  const checks = [...report.checks, check];
  const blockingFailures = checks.filter(
    (entry) => entry.status === 'fail',
  ).length;
  const warnings = checks.filter((entry) => entry.status === 'warn').length;
  return {
    checks,
    blockingFailures,
    warnings,
    ok: blockingFailures === 0,
  };
}

function loadSettingsForDoctor(runtimeHome: string): {
  settings?: RuntimeSettings;
  error?: string;
} {
  try {
    return { settings: ensureRuntimeSettings(runtimeHome) };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runDoctor(
  importMetaUrl: string,
  runtimeHome: string,
): DoctorReport {
  const checks: DoctorCheck[] = [];

  const nodeMajor = getNodeMajorVersion();
  const nodeVersion = getNodeVersion();
  if (nodeMajor >= 25) {
    add(checks, {
      id: 'node-version',
      title: 'Node.js Version',
      status: 'pass',
      message: `Node ${nodeVersion} detected.`,
    });
  } else {
    add(checks, {
      id: 'node-version',
      title: 'Node.js Version',
      status: 'fail',
      message: `Node ${nodeVersion} detected. MyClaw requires Node 25 or newer.`,
      nextAction: 'Install Node.js 25+ and run `myclaw doctor` again.',
    });
  }

  try {
    assertRuntimeEntryExists(importMetaUrl);
    add(checks, {
      id: 'runtime-entry',
      title: 'Runtime Files',
      status: 'pass',
      message: `Runtime entry found at ${getRuntimeEntryPath(importMetaUrl)}.`,
    });
  } catch (err) {
    add(checks, {
      id: 'runtime-entry',
      title: 'Runtime Files',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
      nextAction: 'Reinstall MyClaw from npm, then run `myclaw doctor` again.',
    });
  }

  try {
    ensureRuntimeWritable(runtimeHome);
    add(checks, {
      id: 'runtime-home',
      title: 'Runtime Home',
      status: 'pass',
      message: `Runtime home is writable: ${runtimeHome}`,
    });
  } catch (err) {
    add(checks, {
      id: 'runtime-home',
      title: 'Runtime Home',
      status: 'fail',
      message: `Cannot write to runtime home ${runtimeHome}.`,
      nextAction:
        err instanceof Error
          ? `Fix permissions or choose another runtime home. Details: ${err.message}`
          : 'Fix runtime-home permissions or choose a different path.',
    });
  }

  const ipcBaseDir = path.join(runtimeHome, 'data', 'ipc');
  try {
    fs.mkdirSync(ipcBaseDir, { recursive: true });
    add(checks, {
      id: 'ipc-layout',
      title: 'IPC Layout',
      status: 'pass',
      message:
        'IPC base directory is writable. Use `myclaw status` for Postgres-backed group counts.',
    });
  } catch (err) {
    add(checks, {
      id: 'ipc-layout',
      title: 'IPC Layout',
      status: 'fail',
      message: `IPC layout is not writable at ${ipcBaseDir}.`,
      nextAction:
        err instanceof Error
          ? `Fix runtime-home permissions. Details: ${err.message}`
          : 'Fix runtime-home permissions and rerun doctor.',
    });
  }

  const envPath = envFilePath(runtimeHome);
  const env = readEnvFile(envPath);

  const settingsResult = loadSettingsForDoctor(runtimeHome);
  const settings = settingsResult.settings;
  const providers = listConnectableChannelProviders();
  const enabledProviders = settings
    ? providers.filter((provider) => settings.channels[provider.id]?.enabled)
    : [];
  if (settings) {
    if (enabledProviders.length > 0) {
      add(checks, {
        id: 'runtime-settings',
        title: 'Runtime Settings',
        status: 'pass',
        message: `Runtime settings loaded from ${path.join(runtimeHome, 'settings.yaml')} with canonical memory block.`,
      });
    } else {
      add(checks, {
        id: 'runtime-settings',
        title: 'Runtime Settings',
        status: 'fail',
        message:
          'Runtime settings are valid, but no channels are enabled in settings.yaml.',
        nextAction: `Run ${providers.map((provider) => `\`myclaw ${provider.id} connect\``).join(' or ')} to enable a channel.`,
      });
    }
    const postgresUrlEnv = settings.storage.postgres.urlEnv;
    const postgresUrl =
      env[postgresUrlEnv]?.trim() || process.env[postgresUrlEnv]?.trim() || '';
    let storageStatus: DoctorStatus = 'pass';
    let storageMessage = `Postgres runtime storage is configured via ${postgresUrlEnv}.`;
    let storageNextAction: string | undefined;
    if (!postgresUrl) {
      storageStatus = 'fail';
      storageMessage = `${postgresUrlEnv} is missing.`;
      storageNextAction = `Set ${postgresUrlEnv} in ${envPath}.`;
    } else {
      try {
        validatePostgresConnectionUrl(postgresUrl, {
          allowLocalhost: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        storageStatus = 'fail';
        storageMessage = `${postgresUrlEnv} is invalid: ${message}`;
        storageNextAction = `Update ${postgresUrlEnv} in ${envPath}.`;
      }
    }

    add(checks, {
      id: 'runtime-storage',
      title: 'Runtime Storage',
      status: storageStatus,
      message: storageMessage,
      nextAction: storageNextAction,
    });
  } else {
    add(checks, {
      id: 'runtime-settings',
      title: 'Runtime Settings',
      status: 'fail',
      message: 'Runtime settings file is invalid.',
      nextAction: `Fix ${path.join(runtimeHome, 'settings.yaml')}. Details: ${settingsResult.error}`,
    });
  }
  const onecliUrl = env.ONECLI_URL?.trim() || '';

  for (const provider of providers) {
    const enabled = settings?.channels[provider.id]?.enabled ?? false;
    const configuredKeys = provider.setup.envKeys.filter((envKey) =>
      Boolean(env[envKey]?.trim()),
    );
    const missingKeys = provider.setup.envKeys.filter(
      (envKey) => !env[envKey]?.trim(),
    );
    const envCheckId =
      provider.id === 'telegram'
        ? 'telegram-token'
        : provider.id === 'slack'
          ? 'slack-tokens'
          : `${provider.id}-credentials`;
    const envCheckTitle =
      provider.id === 'telegram'
        ? 'Telegram Token'
        : provider.id === 'slack'
          ? 'Slack Tokens'
          : `${provider.label} Credentials`;

    if (!enabled) {
      add(checks, {
        id: envCheckId,
        title: envCheckTitle,
        status: 'pass',
        message: `${provider.label} channel is disabled in settings.yaml.`,
      });
    } else if (missingKeys.length === 0) {
      add(checks, {
        id: envCheckId,
        title: envCheckTitle,
        status: 'pass',
        message:
          provider.id === 'telegram'
            ? 'Telegram token is configured.'
            : provider.id === 'slack'
              ? 'Slack bot/app tokens are configured.'
              : `${provider.label} credentials are configured.`,
      });
    } else {
      const partialConfigured = configuredKeys.length > 0;
      add(checks, {
        id: envCheckId,
        title: envCheckTitle,
        status: 'warn',
        message:
          provider.id === 'telegram'
            ? `Telegram token is missing in ${envPath}.`
            : provider.id === 'slack' && partialConfigured
              ? 'Slack token setup is incomplete (both bot and app tokens are required).'
              : `${provider.label} credentials are missing in ${envPath}.`,
        nextAction: `Run \`myclaw ${provider.id} connect\` to configure ${provider.label}.`,
      });
    }
  }

  const memoryHealth = inspectMemoryHealth(runtimeHome, settings, env);
  add(checks, {
    id: 'memory-provider',
    title: 'Memory Storage',
    status: memoryHealth.memoryCheck.status,
    message: `root=${memoryHealth.memoryRoot} (source: ${memoryHealth.memoryRootSource}): ${memoryHealth.memoryCheck.message}`,
    nextAction: memoryHealth.memoryCheck.nextAction,
  });
  add(checks, {
    id: 'embeddings-provider',
    title: 'Memory Embeddings',
    status: memoryHealth.embeddingCheck.status,
    message: `${memoryHealth.embeddingProvider} (source: ${memoryHealth.embeddingProviderSource}): ${memoryHealth.embeddingCheck.message}`,
    nextAction: memoryHealth.embeddingCheck.nextAction,
  });
  add(checks, {
    id: 'claude-broker',
    title: 'Claude Broker',
    status: onecliUrl ? 'pass' : 'warn',
    message: onecliUrl
      ? `OneCLI broker is configured at ${onecliUrl}.`
      : 'OneCLI broker is missing. Agent execution and memory LLM extraction require brokered model access.',
    nextAction: onecliUrl
      ? undefined
      : 'Run `myclaw setup` and configure ONECLI_URL, then rerun `myclaw doctor`.',
  });

  const platform = detectPlatform();
  if (platform === 'linux') {
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: hasSystemdUser() ? 'pass' : 'warn',
      message: hasSystemdUser()
        ? 'systemd user session is available.'
        : 'systemd user session is not available. Background service will use a nohup fallback.',
      nextAction: hasSystemdUser()
        ? undefined
        : 'Use `myclaw service install` to create the fallback start script.',
    });
  } else if (platform === 'windows') {
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: 'pass',
      message: 'Background service mode is available on Windows.',
      nextAction: 'Use `myclaw service install` then `myclaw service start`.',
    });
  } else if (platform === 'macos') {
    const hasLaunchctl = commandExists('launchctl');
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: hasLaunchctl ? 'pass' : 'warn',
      message: hasLaunchctl
        ? 'launchd is available.'
        : 'launchctl is unavailable in this shell session.',
      nextAction: hasLaunchctl
        ? 'Use `myclaw service install` then `myclaw service start`.'
        : 'Run from a normal macOS user session and retry.',
    });
  }

  const blockingFailures = checks.filter(
    (check) => check.status === 'fail',
  ).length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  return {
    ok: blockingFailures === 0,
    blockingFailures,
    warnings,
    checks,
  };
}

export async function runDoctorWithNetwork(
  importMetaUrl: string,
  runtimeHome: string,
  options: DoctorNetworkOptions = {},
): Promise<DoctorReport> {
  let report = runDoctor(importMetaUrl, runtimeHome);
  const validateTelegramToken = options.validateTelegramToken !== false;
  if (validateTelegramToken) {
    const telegramProvider = getChannelProvider('telegram');
    if (telegramProvider) {
      const settings = loadSettingsForDoctor(runtimeHome).settings;
      if (settings?.channels[telegramProvider.id]?.enabled) {
        const env = readEnvFile(envFilePath(runtimeHome));
        const token = env.TELEGRAM_BOT_TOKEN?.trim() || '';
        if (token) {
          const validation = await validateTelegramBotToken(
            token,
            options.telegramTimeoutMs,
          );
          if (validation.ok) {
            report = addToReport(report, {
              id: 'telegram-token-api',
              title: 'Telegram Token API Validation',
              status: 'pass',
              message: validation.message,
            });
          } else {
            report = addToReport(report, {
              id: 'telegram-token-api',
              title: 'Telegram Token API Validation',
              status: 'warn',
              message: validation.message,
              nextAction:
                validation.nextAction ||
                'Refresh TELEGRAM_BOT_TOKEN and rerun doctor.',
            });
          }
        }
      }
    }
  }

  const storageReadiness = await inspectRuntimeStorageReadiness(runtimeHome);
  report = addToReport(report, {
    id: 'storage-capabilities',
    title: 'Storage Capabilities',
    status: storageReadiness.status,
    message: storageReadiness.details?.length
      ? `${storageReadiness.message} ${storageReadiness.details.join(' | ')}`
      : storageReadiness.message,
    nextAction: storageReadiness.nextAction,
  });
  return report;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('MyClaw Doctor Report');
  lines.push('');
  for (const check of report.checks) {
    lines.push(
      `[${statusLabel(check.status)}] ${check.title}: ${check.message}`,
    );
    if (check.nextAction) {
      lines.push(`  Next action: ${check.nextAction}`);
    }
  }
  lines.push('');
  lines.push(
    report.ok
      ? `Doctor finished with ${report.warnings} warning(s).`
      : `Doctor found ${report.blockingFailures} blocking issue(s) and ${report.warnings} warning(s).`,
  );
  return lines.join('\n');
}

export function hasRuntimeConfig(runtimeHome: string): boolean {
  try {
    const settings = ensureRuntimeSettings(runtimeHome);
    return listConnectableChannelProviders().some(
      (provider) => settings.channels[provider.id]?.enabled,
    );
  } catch {
    return false;
  }
}

export async function hasProcessableGroupForConfiguredChannel(
  runtimeHome: string,
): Promise<boolean> {
  let settings: RuntimeSettings;
  try {
    settings = ensureRuntimeSettings(runtimeHome);
  } catch {
    return false;
  }

  const env = readEnvFile(envFilePath(runtimeHome));

  for (const provider of listConnectableChannelProviders()) {
    if (!settings.channels[provider.id]?.enabled) continue;
    const hasRequiredCredentials = provider.setup.envKeys.every((envKey) =>
      Boolean(env[envKey]?.trim()),
    );
    if (!hasRequiredCredentials) continue;
    let db: Awaited<ReturnType<typeof openRuntimeGroupDb>> | undefined;
    try {
      db = await openRuntimeGroupDb(runtimeHome, { migrate: false });
      const count = await db.countRegisteredGroupsByJidPrefix(
        provider.jidPrefix,
      );
      if (count > 0) return true;
    } catch {
      continue;
    } finally {
      await db?.close();
    }
  }

  return false;
}