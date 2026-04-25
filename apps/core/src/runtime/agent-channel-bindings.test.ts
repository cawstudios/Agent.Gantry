import { describe, expect, it, vi } from 'vitest';

import { reconcileAgentChannelBindings } from './agent-channel-bindings.js';
import type { ConfiguredAgent } from './agent-config-registry.js';
import type { RegisteredGroup } from '../core/types.js';

function makeAgent(overrides: Partial<ConfiguredAgent> = {}): ConfiguredAgent {
  return {
    id: 'people-ops-agent',
    folder: 'people-ops-agent',
    sourcePath: '/tmp/people-ops-agent/agent.yaml',
    channel: 'slack',
    timezone: 'Asia/Kolkata',
    channelJids: ['sl:C123'],
    enabledWorkflows: [],
    ...overrides,
  };
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'People Ops',
    folder: 'g1',
    trigger: '@MyClaw',
    added_at: '2026-04-24T00:00:00.000Z',
    requiresTrigger: false,
    isMain: true,
    ...overrides,
  };
}

describe('agent-channel-bindings', () => {
  it('rebinds declared channel jids from anonymous folders to configured agent folders', () => {
    const persist = vi.fn();
    const registeredGroups = {
      'sl:C123': makeGroup(),
    };

    const result = reconcileAgentChannelBindings({
      configuredAgents: { 'people-ops-agent': makeAgent() },
      registeredGroups,
      persist,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.reboundJids).toEqual(['sl:C123']);
    expect(result.orphanFolders).toEqual([]);
    expect(registeredGroups['sl:C123'].folder).toBe('people-ops-agent');
    expect(persist).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({ folder: 'people-ops-agent' }),
    );
  });

  it('reports missing configured channel bindings and orphan registered folders', () => {
    const warn = vi.fn();
    const result = reconcileAgentChannelBindings({
      configuredAgents: { 'people-ops-agent': makeAgent() },
      registeredGroups: {
        'sl:C999': makeGroup({ folder: 'legacy-group' }),
      },
      persist: vi.fn(),
      logger: { info: vi.fn(), warn },
    });

    expect(result.missingJids).toEqual(['sl:C123']);
    expect(result.orphanFolders).toEqual(['legacy-group']);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'sl:C123' }),
      'Configured agent channel binding has no registered group',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'legacy-group' }),
      'Registered channel folder is not backed by agent.yaml',
    );
  });
});
