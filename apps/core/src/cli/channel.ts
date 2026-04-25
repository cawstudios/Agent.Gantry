import * as p from '@clack/prompts';

import {
  getChannelProvider,
  listConnectableChannelProviders,
} from '../channels/provider-registry.js';
import { readEnvFile } from '../config/env/file.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import type { DoctorReport } from './doctor.js';

function usage(): string {
  return [
    'Usage:',
    '  myclaw channel connect <telegram|slack>',
    '  myclaw channel list',
    '  myclaw channel doctor',
  ].join('\n');
}

function formatChannelList(runtimeHome: string): string {
  const settings = ensureRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const lines = ['Channels', ''];
  for (const provider of listConnectableChannelProviders()) {
    const enabled = settings.channels[provider.id]?.enabled ?? false;
    const missing = provider.setup.envKeys.filter(
      (envKey) => !env[envKey]?.trim(),
    );
    lines.push(
      `${provider.label}: ${enabled ? 'enabled' : 'disabled'} | credentials: ${
        missing.length === 0 ? 'configured' : `missing ${missing.join(', ')}`
      }`,
    );
  }
  return lines.join('\n');
}

function scopeChannelDoctorReport(report: DoctorReport): DoctorReport {
  const channelChecks = report.checks.filter((check) =>
    [
      'runtime-settings',
      'telegram-token',
      'telegram-token-api',
      'slack-tokens',
    ].includes(check.id),
  );
  const checks = channelChecks.length > 0 ? channelChecks : report.checks;
  const blockingFailures = checks.filter(
    (check) => check.status === 'fail',
  ).length;
  return {
    ...report,
    checks,
    blockingFailures,
    warnings: checks.filter((check) => check.status === 'warn').length,
    ok: blockingFailures === 0,
  };
}

export async function runChannelCommand(
  importMetaUrl: string,
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, providerId] = args;
  if (!command || command === 'list') {
    p.note(formatChannelList(runtimeHome), 'Channel Status');
    return 0;
  }

  if (command === 'connect') {
    if (!providerId) {
      p.log.error(usage());
      return 1;
    }
    const provider = getChannelProvider(providerId);
    if (!provider) {
      p.log.error(`Unknown channel: ${providerId}`);
      return 1;
    }
    const { runProviderConnectCommand } = await import('./provider-connect.js');
    return runProviderConnectCommand(runtimeHome, provider.id);
  }

  if (command === 'doctor') {
    const { formatDoctorReport, runDoctorWithNetwork } =
      await import('./doctor.js');
    const report = await runDoctorWithNetwork(importMetaUrl, runtimeHome);
    const scoped = scopeChannelDoctorReport(report);
    p.note(formatDoctorReport(scoped), 'Channel Doctor');
    return scoped.ok ? 0 : 1;
  }

  p.log.error(usage());
  return 1;
}
