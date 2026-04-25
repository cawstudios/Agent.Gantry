import { listChannelProviders } from '../../channels/provider-registry.js';
import { renderControlAllowlistYaml } from './control-allowlist.js';
import { renderSenderAllowlistYaml } from './sender-allowlist.js';
import { quoteYamlString } from './yaml.js';
import { createDefaultChannelSettings } from './runtime-settings-defaults.js';
import type {
  RuntimeCredentialBrokerSettings,
  RuntimeMemorySettings,
  RuntimeSettings,
  RuntimeStorageSettings,
} from './runtime-settings-types.js';

function quoteYamlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return JSON.stringify(key);
}

function renderMemorySettingsYaml(
  lines: string[],
  memory: RuntimeMemorySettings,
): void {
  lines.push(
    'memory:',
    `  enabled: ${memory.enabled ? 'true' : 'false'}`,
    '  embeddings:',
    `    enabled: ${memory.embeddings.enabled ? 'true' : 'false'}`,
    `    provider: ${memory.embeddings.provider}`,
    `    model: ${quoteYamlString(memory.embeddings.model)}`,
    '  dreaming:',
    `    enabled: ${memory.dreaming.enabled ? 'true' : 'false'}`,
    '  llm:',
    '    models:',
    `      extractor: ${quoteYamlString(memory.llm.models.extractor)}`,
    `      dreaming: ${quoteYamlString(memory.llm.models.dreaming)}`,
    `      consolidation: ${quoteYamlString(memory.llm.models.consolidation)}`,
    '',
  );
}

function renderStorageSettingsYaml(
  lines: string[],
  storage: RuntimeStorageSettings,
): void {
  lines.push(
    'storage:',
    '  postgres:',
    `    url_env: ${quoteYamlString(storage.postgres.urlEnv)}`,
    `    schema: ${quoteYamlString(storage.postgres.schema)}`,
    '',
  );
}

function renderCredentialBrokerSettingsYaml(
  lines: string[],
  credentialBroker: RuntimeCredentialBrokerSettings,
): void {
  lines.push(
    'credential_broker:',
    '  onecli:',
    '    postgres:',
    `      url_env: ${quoteYamlString(credentialBroker.onecli.postgres.urlEnv)}`,
    `      schema: ${quoteYamlString(credentialBroker.onecli.postgres.schema)}`,
    '',
  );
}

export function renderRuntimeSettingsYaml(settings: RuntimeSettings): string {
  const lines = ['channels:'];
  const providerIds = listChannelProviders().map((provider) => provider.id);
  const extraIds = Object.keys(settings.channels)
    .filter((id) => !providerIds.includes(id))
    .sort((a, b) => a.localeCompare(b));

  for (const channelId of [...providerIds, ...extraIds]) {
    const channelSettings =
      settings.channels[channelId] || createDefaultChannelSettings(false);
    lines.push(
      `  ${quoteYamlKey(channelId)}:`,
      `    enabled: ${channelSettings.enabled ? 'true' : 'false'}`,
      '    sender_allowlist:',
    );
    renderSenderAllowlistYaml(
      lines,
      '      ',
      quoteYamlKey,
      channelSettings.senderAllowlist,
    );
    lines.push('    control_allowlist:');
    renderControlAllowlistYaml(
      lines,
      '      ',
      quoteYamlKey,
      channelSettings.controlAllowlist,
    );
  }

  lines.push('');
  renderStorageSettingsYaml(lines, settings.storage);
  renderCredentialBrokerSettingsYaml(lines, settings.credentialBroker);
  renderMemorySettingsYaml(lines, settings.memory);

  return lines.join('\n');
}
