import { describe, expect, it, vi } from 'vitest';

import {
  classifySettingsChanges,
  SettingsDesiredStateService,
} from '@core/config/settings/desired-state-service.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';

function makeRepositories(overrides: Record<string, unknown> = {}) {
  return {
    agents: {
      saveAgent: vi.fn(async () => undefined),
      listAgentDmAccess: vi.fn(async () => []),
      listAgentDmApprovers: vi.fn(async () => []),
      replaceAgentDmAccessPolicy: vi.fn(async () => undefined),
      replaceAgentCapabilityBindings: vi.fn(async () => undefined),
      disableAgent: vi.fn(async () => undefined),
      listAgents: vi.fn(async () => []),
    },
    tools: {
      getTool: vi.fn(async (id: string) =>
        id === 'tool:read'
          ? {
              id,
              appId: 'default',
              status: 'active',
              selectable: true,
            }
          : null,
      ),
      listAgentToolBindings: vi.fn(async () => []),
    },
    skills: {
      getSkill: vi.fn(async (id: string) =>
        id === 'skill:admin'
          ? {
              id,
              appId: 'default',
              status: 'approved',
              storage: { type: 'local' },
            }
          : null,
      ),
      listAgentSkillBindings: vi.fn(async () => []),
    },
    mcpServers: {
      getServer: vi.fn(async (id: string) =>
        id === 'mcp:github'
          ? {
              id,
              appId: 'default',
              status: 'approved',
              latestApprovedVersionId: 'mcp-version:github',
            }
          : null,
      ),
      listAgentBindings: vi.fn(async () => []),
    },
    ...overrides,
  } as any;
}

function makeOps(groups: Record<string, any> = {}) {
  return {
    getAllRegisteredGroups: vi.fn(async () => groups),
    setRegisteredGroup: vi.fn(async () => undefined),
    deleteRegisteredGroup: vi.fn(async () => undefined),
  };
}

describe('SettingsDesiredStateService', () => {
  it('validates capability references before reconciliation', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: ['tool:read', 'tool:missing'],
        skillIds: ['skill:admin'],
        mcpServerIds: ['mcp:github'],
      },
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories: makeRepositories(),
    });

    await expect(
      service.validateCapabilityReferences(settings),
    ).resolves.toEqual([
      'agents.main_agent.capabilities.tool_ids contains unavailable tool: tool:missing',
    ]);
  });

  it('reconciles desired agents without deleting DB-only bindings in phase 1', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = false;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {
        primary: {
          jid: 'tg:100',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          requiresTrigger: true,
          isMain: true,
        },
      },
      dmAccess: [],
      capabilities: {
        toolIds: [],
        skillIds: [],
        mcpServerIds: [],
      },
    };
    const ops = makeOps({
      'tg:old': {
        name: 'Old',
        folder: 'old',
        trigger: '@old',
        added_at: '2026-05-01T00:00:00.000Z',
      },
    });
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({ ops, repositories });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences).toEqual([]);
    expect(ops.setRegisteredGroup).toHaveBeenCalledWith(
      'tg:100',
      expect.objectContaining({ folder: 'main_agent', trigger: '@main' }),
    );
    expect(ops.deleteRegisteredGroup).not.toHaveBeenCalled();
  });

  it('removes absent DB bindings only in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: [],
        skillIds: [],
        mcpServerIds: [],
      },
    };
    const ops = makeOps({
      'tg:old': {
        name: 'Old',
        folder: 'old',
        trigger: '@old',
        added_at: '2026-05-01T00:00:00.000Z',
      },
    });
    const service = new SettingsDesiredStateService({
      ops,
      repositories: makeRepositories(),
    });

    await service.reconcile(settings);

    expect(ops.deleteRegisteredGroup).toHaveBeenCalledWith('tg:old');
  });

  it('clears empty capability selections in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: [],
        skillIds: [],
        mcpServerIds: [],
      },
    };
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:main_agent',
        toolBindings: [],
        skillBindings: [],
        mcpBindings: [],
      }),
    );
  });

  it('exports colliding channel bindings without overwriting one another', async () => {
    const settings = createDefaultRuntimeSettings();
    const service = new SettingsDesiredStateService({
      ops: makeOps({
        'tg abc': {
          name: 'A',
          folder: 'main_agent',
          trigger: '@a',
          added_at: '2026-05-01T00:00:00.000Z',
        },
        'tg/abc': {
          name: 'B',
          folder: 'main_agent',
          trigger: '@b',
          added_at: '2026-05-01T00:00:00.000Z',
        },
      }),
      repositories: makeRepositories(),
    });

    const exported = await service.exportCurrent(settings);
    const bindingJids = Object.values(exported.agents.main_agent.bindings).map(
      (binding) => binding.jid,
    );

    expect(bindingJids.sort()).toEqual(['tg abc', 'tg/abc']);
    expect(Object.keys(exported.agents.main_agent.bindings)).toHaveLength(2);
  });

  it('disables DB-only agents and clears their policies in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: [],
        skillIds: [],
        mcpServerIds: [],
      },
    };
    const repositories = makeRepositories({
      agents: {
        saveAgent: vi.fn(async () => undefined),
        listAgents: vi.fn(async () => [
          {
            id: 'agent:old_agent',
            appId: 'default',
            name: 'Old',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
        listAgentDmAccess: vi.fn(async () => []),
        listAgentDmApprovers: vi.fn(async () => []),
        replaceAgentDmAccessPolicy: vi.fn(async () => undefined),
        replaceAgentCapabilityBindings: vi.fn(async () => undefined),
        disableAgent: vi.fn(async () => undefined),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(repositories.agents.disableAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent:old_agent' }),
    );
    expect(repositories.agents.replaceAgentDmAccessPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:old_agent',
        accessEntries: [],
        approverEntries: [],
      }),
    );
  });

  it('classifies topology changes as restart-required', () => {
    const before = createDefaultRuntimeSettings();
    const after = createDefaultRuntimeSettings();
    after.agent.defaultModel = 'sonnet';
    after.channels.telegram.enabled = !before.channels.telegram.enabled;

    expect(classifySettingsChanges(before, after)).toEqual({
      liveApplied: ['agent_defaults'],
      restartRequired: ['channels'],
    });
  });

  it('classifies agent capability and memory changes as restart-required', () => {
    const before = createDefaultRuntimeSettings();
    const after = createDefaultRuntimeSettings();
    after.memory.enabled = false;
    after.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: ['tool:read'],
        skillIds: [],
        mcpServerIds: [],
      },
    };

    expect(classifySettingsChanges(before, after)).toEqual({
      liveApplied: [],
      restartRequired: ['agents', 'memory'],
    });
  });
});
