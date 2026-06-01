import '../channels/register-builtins.js';
import { listConnectableChannelProviders } from '../channels/provider-registry.js';

import { readEnvFile } from '../config/env/file.js';
import { DoctorReport, runDoctorWithNetwork } from './doctor.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import { inspectMemoryHealth } from './memory-health.js';
import {
  buildControlPlaneReadModelFromSettings,
  formatControlPlaneStatus,
  type ControlPlaneMemoryStatus,
} from '../application/control-plane/control-plane-read-model.js';

export interface RuntimeStatusSummary {
  doctor: DoctorReport;
  channels: Array<{
    id: string;
    label: string;
    enabled: boolean;
    missingEnvKeys: string[];
  }>;
  accessNeedsApprovalCount: number;
  modelCredentialReady: boolean;
  memoryStatus: ControlPlaneMemoryStatus;
  settings: ReturnType<typeof ensureRuntimeSettings>;
}

export async function collectRuntimeStatus(
  importMetaUrl: string,
  runtimeHome: string,
): Promise<RuntimeStatusSummary> {
  const env = readEnvFile(envFilePath(runtimeHome));
  const settings = ensureRuntimeSettings(runtimeHome);
  const doctor = await runDoctorWithNetwork(importMetaUrl, runtimeHome, {
    validateTelegramToken: false,
  });
  const memoryHealth = inspectMemoryHealth(runtimeHome, settings, env);
  const brokerCheck = doctor.checks.find(
    (check) => check.id === 'claude-broker',
  );
  const connectedProviderIds = new Set(
    Object.values(settings.providerConnections).map(
      (connection) => connection.provider,
    ),
  );

  const channels = listConnectableChannelProviders()
    .filter(
      (provider) =>
        settings.providers[provider.id]?.enabled === true ||
        connectedProviderIds.has(provider.id),
    )
    .map((provider) => {
      const missingEnvKeys: string[] = [];
      for (const envKey of provider.setup.envKeys) {
        if (!env[envKey]?.trim()) {
          missingEnvKeys.push(envKey);
        }
      }

      return {
        id: provider.id,
        label: provider.label,
        enabled: settings.providers[provider.id]?.enabled ?? false,
        missingEnvKeys,
      };
    });

  return {
    doctor,
    channels,
    accessNeedsApprovalCount: 0,
    modelCredentialReady: brokerCheck?.status === 'pass',
    memoryStatus: toControlPlaneMemoryStatus(
      memoryHealth.memoryEnabled,
      memoryHealth.memoryCheck.status,
    ),
    settings,
  };
}

export function formatRuntimeStatus(summary: RuntimeStatusSummary): string {
  return formatControlPlaneStatus(
    buildControlPlaneReadModelFromSettings({
      settings: summary.settings,
      workspaceKey: 'default',
      runtimeBlocked: !summary.doctor.ok && summary.doctor.blockingFailures > 0,
      modelCredentialReady: summary.modelCredentialReady,
      providers: summary.channels.map((channel) => ({
        id: channel.id,
        label: channel.label,
        ready: channel.enabled && channel.missingEnvKeys.length === 0,
      })),
      accessNeedsApprovalCount: summary.accessNeedsApprovalCount,
      memoryStatus: summary.memoryStatus,
    }),
  );
}

function toControlPlaneMemoryStatus(
  enabled: boolean,
  health: string,
): ControlPlaneMemoryStatus {
  if (!enabled) return 'Disabled';
  if (health === 'pass') return 'Ready';
  return 'Needs setup';
}
