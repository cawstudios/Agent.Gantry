import { listChannelProviders } from '../../channels/provider-registry.js';
import { renderControlAllowlistYaml } from './control-allowlist.js';
import { renderSenderAllowlistYaml } from './sender-allowlist.js';
import { quoteYamlString } from './yaml.js';
import { createDefaultChannelSettings } from './runtime-settings-defaults.js';
import type {
  RuntimeCredentialBrokerSettings,
  RuntimeAgentSettings,
  RuntimeConfiguredAgent,
  RuntimeDesiredStateSettings,
  RuntimeMemorySettings,
  RuntimeSettings,
  RuntimeStorageSettings,
} from './runtime-settings-types.js';

function quoteYamlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return JSON.stringify(key);
}

function renderAgentSettingsYaml(
  lines: string[],
  agent: RuntimeAgentSettings,
): void {
  lines.push(
    'agent:',
    `  name: ${quoteYamlString(agent.name)}`,
    `  default_model: ${quoteYamlString(agent.defaultModel)}`,
    `  one_time_job_default_model: ${quoteYamlString(agent.oneTimeJobDefaultModel)}`,
    `  recurring_job_default_model: ${quoteYamlString(agent.recurringJobDefaultModel)}`,
    '  sessions:',
    `    memory_item_limit: ${agent.sessions.memoryItemLimit}`,
    `    max_memory_context_chars: ${agent.sessions.maxMemoryContextChars}`,
    '',
  );
}

function renderDesiredStateYaml(
  lines: string[],
  desiredState: RuntimeDesiredStateSettings,
): void {
  lines.push(
    'desired_state:',
    `  authoritative: ${desiredState.authoritative ? 'true' : 'false'}`,
    '',
  );
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

function renderConfiguredAgentsYaml(
  lines: string[],
  agents: Record<string, RuntimeConfiguredAgent>,
): void {
  const entries = Object.entries(agents).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    lines.push('agents: {}', '');
    return;
  }
  lines.push('agents:');
  for (const [folder, agent] of entries) {
    lines.push(
      `  ${quoteYamlKey(folder)}:`,
      `    name: ${quoteYamlString(agent.name)}`,
    );
    if (agent.model) {
      lines.push(`    model: ${quoteYamlString(agent.model)}`);
    }
    if (agent.oneTimeJobDefaultModel) {
      lines.push(
        `    one_time_job_default_model: ${quoteYamlString(agent.oneTimeJobDefaultModel)}`,
      );
    }
    if (agent.recurringJobDefaultModel) {
      lines.push(
        `    recurring_job_default_model: ${quoteYamlString(agent.recurringJobDefaultModel)}`,
      );
    }
    const bindingEntries = Object.entries(agent.bindings).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    if (bindingEntries.length === 0) {
      lines.push('    bindings: {}');
    } else {
      lines.push('    bindings:');
      for (const [bindingId, binding] of bindingEntries) {
        lines.push(
          `      ${quoteYamlKey(bindingId)}:`,
          `        jid: ${quoteYamlString(binding.jid)}`,
        );
        if (binding.provider) {
          lines.push(`        provider: ${quoteYamlString(binding.provider)}`);
        }
        if (binding.name) {
          lines.push(`        name: ${quoteYamlString(binding.name)}`);
        }
        lines.push(
          `        trigger: ${quoteYamlString(binding.trigger)}`,
          `        added_at: ${quoteYamlString(binding.addedAt)}`,
          `        requires_trigger: ${binding.requiresTrigger ? 'true' : 'false'}`,
          `        main: ${binding.isMain ? 'true' : 'false'}`,
        );
        if (binding.model) {
          lines.push(`        model: ${quoteYamlString(binding.model)}`);
        }
      }
    }
    if (agent.dmAccess.length === 0) {
      lines.push('    dm_access: {}');
    } else {
      lines.push('    dm_access:');
      for (const entry of [...agent.dmAccess].sort((a, b) =>
        a.provider.localeCompare(b.provider),
      )) {
        lines.push(
          `      ${quoteYamlKey(entry.provider)}:`,
          `        allow: ${JSON.stringify(entry.userIds)}`,
        );
        if (entry.adminUserId) {
          lines.push(`        admin: ${quoteYamlString(entry.adminUserId)}`);
        }
      }
    }
    lines.push(
      '    capabilities:',
      `      tool_ids: ${JSON.stringify(agent.capabilities.toolIds)}`,
      `      skill_ids: ${JSON.stringify(agent.capabilities.skillIds)}`,
      `      mcp_server_ids: ${JSON.stringify(agent.capabilities.mcpServerIds)}`,
    );
  }
  lines.push('');
}

function renderCredentialBrokerSettingsYaml(
  lines: string[],
  credentialBroker: RuntimeCredentialBrokerSettings,
): void {
  lines.push(
    'credential_broker:',
    `  mode: ${quoteYamlString(credentialBroker.mode)}`,
    '  onecli:',
    `    url: ${quoteYamlString(credentialBroker.onecli.url)}`,
    '    postgres:',
    `      url_env: ${quoteYamlString(credentialBroker.onecli.postgres.urlEnv)}`,
    `      schema: ${quoteYamlString(credentialBroker.onecli.postgres.schema)}`,
    '  external:',
    `    base_url: ${quoteYamlString(credentialBroker.external.baseUrl)}`,
    '',
  );
}

export function renderRuntimeSettingsYaml(settings: RuntimeSettings): string {
  const lines: string[] = [];
  renderDesiredStateYaml(lines, settings.desiredState);
  lines.push('channels:');
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
  renderConfiguredAgentsYaml(lines, settings.agents);
  renderStorageSettingsYaml(lines, settings.storage);
  renderAgentSettingsYaml(lines, settings.agent);
  renderCredentialBrokerSettingsYaml(lines, settings.credentialBroker);
  renderMemorySettingsYaml(lines, settings.memory);

  return lines.join('\n');
}
