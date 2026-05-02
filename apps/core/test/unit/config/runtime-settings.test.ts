import { describe, expect, it } from 'vitest';

import {
  createDefaultRuntimeSettings,
  ensureConfiguredConversationBinding,
  parseRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import { validateLoadedRuntimeSettings } from '@core/config/settings/runtime-settings-validation.js';

describe('runtime settings', () => {
  it('defaults, renders, and parses agent.name', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.agent.name).toBe('Main Agent');

    settings.agent.name = 'Kai';
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('name: Kai');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.agent.name).toBe('Kai');
  });

  it('defaults, renders, and parses job model defaults', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agent.defaultModel = 'sonnet';
    settings.agent.oneTimeJobDefaultModel = 'kimi';
    settings.agent.recurringJobDefaultModel = 'opus-4.6';

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('one_time_job_default_model: kimi');
    expect(yaml).toContain('recurring_job_default_model: opus-4.6');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.agent.defaultModel).toBe('sonnet');
    expect(parsed.agent.oneTimeJobDefaultModel).toBe('kimi');
    expect(parsed.agent.recurringJobDefaultModel).toBe('opus-4.6');
  });

  it('rejects unsupported agent settings keys', () => {
    const settings = createDefaultRuntimeSettings();
    const yaml = renderRuntimeSettingsYaml(settings).replace(
      '  default_model:',
      '  raw_env: true\n  default_model:',
    );
    expect(() => parseRuntimeSettings(yaml)).toThrow(
      'agent.raw_env is not supported',
    );
  });

  it('validates model defaults against the model catalog', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agent.defaultModel = 'claude-opus-4-7';
    settings.agent.oneTimeJobDefaultModel = 'sonet';

    const result = validateLoadedRuntimeSettings(
      '/tmp/myclaw-missing',
      settings,
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'agent.default_model is invalid: Provider model ID "claude-opus-4-7" is not accepted here.',
    );
    expect(result.failure?.details.join('\n')).toContain(
      'agent.one_time_job_default_model is invalid: Unknown model "sonet". Did you mean "sonnet"?',
    );
  });

  it('renders and parses local desired-state agents', () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main Agent',
      folder: 'main_agent',
      model: 'sonnet',
      oneTimeJobDefaultModel: 'haiku',
      recurringJobDefaultModel: 'opus',
      bindings: {},
      dmAccess: [
        {
          provider: 'telegram',
          userIds: ['42'],
          adminUserId: '42',
        },
      ],
      capabilities: {
        toolIds: ['tool:read'],
        skillIds: ['skill:admin'],
        mcpServerIds: ['mcp:github'],
      },
    };
    settings.providers.telegram.enabled = true;
    settings.providers.telegram.defaultConnection = 'telegram_default';
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.conversations.main_dm = {
      providerConnection: 'telegram_default',
      externalId: '100',
      kind: 'dm',
      displayName: 'Main DM',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['42'],
    };
    settings.bindings.primary = {
      agent: 'main_agent',
      conversation: 'main_dm',
      trigger: '@kai',
      addedAt: '2026-05-02T00:00:00.000Z',
      requiresTrigger: false,
      isMain: true,
      memoryScope: 'conversation',
    };

    const parsed = parseRuntimeSettings(renderRuntimeSettingsYaml(settings));

    expect(parsed.desiredState.authoritative).toBe(true);
    expect(parsed.agents.main_agent.bindings.primary).toMatchObject({
      jid: 'tg:100',
      provider: 'telegram',
      name: 'Main DM',
      trigger: '@kai',
      requiresTrigger: false,
      isMain: true,
    });
    expect(parsed.bindings.primary).toEqual(settings.bindings.primary);
  });

  it('rejects duplicate desired-state conversation bindings', () => {
    const yaml = renderRuntimeSettingsYaml(
      createDefaultRuntimeSettings(),
    ).replace(
      'agents: {}\n',
      `agents:
  one:
    name: One
    bindings:
      primary:
        jid: tg:100
        trigger: '@one'
        added_at: 2026-05-02T00:00:00.000Z
  two:
    name: Two
    bindings:
      primary:
        jid: tg:100
        trigger: '@two'
        added_at: 2026-05-02T00:00:00.000Z
`,
    );

    expect(() => parseRuntimeSettings(yaml)).toThrow(
      'agents.two.bindings contains duplicate jid tg:100; already configured by agents.one',
    );
  });

  it('rejects raw model ids in desired-state agent defaults', () => {
    const yaml = renderRuntimeSettingsYaml(
      createDefaultRuntimeSettings(),
    ).replace(
      'agents: {}\n',
      `agents:
  main_agent:
    name: Main
    model: claude-opus-4-7
    bindings: {}
`,
    );

    expect(() => parseRuntimeSettings(yaml)).toThrow(
      'agents.main_agent.model is invalid: Provider model ID "claude-opus-4-7" is not accepted here.',
    );
  });

  it('keeps generated conversation ids distinct when normalized ids collide', () => {
    const settings = createDefaultRuntimeSettings();

    const first = ensureConfiguredConversationBinding(settings, {
      agentId: 'main_agent',
      agentName: 'Main',
      agentFolder: 'main_agent',
      jid: 'tg:abc-def',
      displayName: 'First',
      trigger: '@main',
      requiresTrigger: true,
      isMain: true,
    });
    const second = ensureConfiguredConversationBinding(settings, {
      agentId: 'second_agent',
      agentName: 'Second',
      agentFolder: 'second_agent',
      jid: 'tg:abc:def',
      displayName: 'Second',
      trigger: '@second',
      requiresTrigger: true,
      isMain: false,
    });

    expect(first.conversationId).not.toEqual(second.conversationId);
    expect(
      Object.values(settings.conversations).map(
        (conversation) => conversation.externalId,
      ),
    ).toEqual(['abc-def', 'abc:def']);
    expect(Object.keys(settings.bindings)).toHaveLength(2);
  });

  it('uses explicit provider conversation kinds from CLI onboarding', () => {
    const settings = createDefaultRuntimeSettings();

    const slack = ensureConfiguredConversationBinding(settings, {
      agentId: 'main_agent',
      agentName: 'Main',
      agentFolder: 'main_agent',
      jid: 'sl:D12345678',
      conversationKind: 'dm',
      displayName: 'Ravi DM',
      trigger: '@main',
      requiresTrigger: false,
      isMain: true,
    });
    const teams = ensureConfiguredConversationBinding(settings, {
      agentId: 'teams_agent',
      agentName: 'Teams',
      agentFolder: 'teams_agent',
      jid: 'teams:19:abc@thread.tacv2',
      conversationKind: 'channel',
      displayName: 'Engineering',
      trigger: '@teams',
      requiresTrigger: false,
      isMain: false,
    });

    expect(settings.conversations[slack.conversationId]?.kind).toBe('dm');
    expect(settings.conversations[teams.conversationId]?.kind).toBe('channel');
  });
});
