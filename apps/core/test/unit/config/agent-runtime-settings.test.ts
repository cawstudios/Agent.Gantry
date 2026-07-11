import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { SettingsDesiredStateService } from '@core/config/settings/desired-state-service.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import { parseRuntimeSettings } from '@core/config/settings/runtime-settings-parser.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import { resolveConfiguredAgentRuntime } from '@core/config/settings/runtime-settings-agent-runtime.js';
import {
  DEFAULT_AGENT_ENGINE,
  DEEPAGENTS_ENGINE,
} from '@core/shared/agent-engine.js';

function emptySources() {
  return { skills: [], mcpServers: [], tools: [] };
}

const installedSkill = {
  id: 'skill:writer',
  appId: 'default',
  name: 'writer',
  source: 'admin_uploaded',
  status: 'installed',
  promptRefs: [],
  toolIds: [],
  workflowRefs: [],
  storage: {
    storageType: 'local-filesystem',
    storageRef: 'skills/writer',
    contentHash: 'sha256:writer',
    sizeBytes: 1,
  },
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
} as const;

function settingsDesiredStateService() {
  return new SettingsDesiredStateService({
    ops: {} as never,
    repositories: {
      tools: {
        listTools: vi.fn(async () => []),
        getTool: vi.fn(async () => null),
      },
      skills: {
        listSkills: vi.fn(async () => [installedSkill]),
        getSkill: vi.fn(async (id: string) =>
          id === installedSkill.id ? installedSkill : null,
        ),
      },
      mcpServers: {
        getServer: vi.fn(async () => ({
          id: 'mcp:stdio-crm',
          appId: 'default',
          name: 'stdio-crm',
          status: 'active',
          createdSource: 'admin',
          riskClass: 'medium',
          transport: 'stdio_template',
          config: { transport: 'stdio_template' },
          allowedToolPatterns: [],
          autoApproveToolPatterns: [],
          credentialRefs: [],
          networkHosts: [],
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        })),
      },
    } as never,
  });
}

describe('agent runtime settings', () => {
  it('resolves configured runtime defaults without resolving missing agents', async () => {
    const originalHome = process.env.GANTRY_HOME;
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-runtime-'),
    );
    const settings = createDefaultRuntimeSettings();
    settings.agents.worker_agent = {
      name: 'Worker',
      folder: 'worker_agent',
      runtime: 'worker',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
      accessPreset: 'full',
    };
    settings.agents.inline_agent = {
      name: 'Inline',
      folder: 'inline_agent',
      runtime: 'inline',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
      accessPreset: 'full',
    };
    settings.agents.default_agent = {
      name: 'Default',
      folder: 'default_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
      accessPreset: 'full',
    };
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      renderRuntimeSettingsYaml(settings),
    );

    vi.resetModules();
    process.env.GANTRY_HOME = runtimeHome;
    try {
      const config = await import('@core/config/index.js');

      expect(config.getConfiguredAgentRuntime('worker_agent')).toBe('worker');
      expect(config.getConfiguredAgentRuntime('inline_agent')).toBe('inline');
      expect(config.getConfiguredAgentRuntime('default_agent')).toBe('worker');
      expect(config.getConfiguredAgentRuntime('missing_agent')).toBeUndefined();
      expect(config.getSelectedAgentRuntime('missing_agent')).toBe('worker');
    } finally {
      if (originalHome === undefined) delete process.env.GANTRY_HOME;
      else process.env.GANTRY_HOME = originalHome;
      fs.rmSync(runtimeHome, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('parses inline runtime and defaults agents to worker', () => {
    const defaults = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
`);
    expect(resolveConfiguredAgentRuntime(defaults.agents.main_agent)).toBe(
      'worker',
    );

    const parsed = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
    max_turns: 12
    effort: xhigh
`);
    expect(resolveConfiguredAgentRuntime(parsed.agents.main_agent)).toBe(
      'inline',
    );

    const rendered = renderRuntimeSettingsYaml(parsed);
    expect(rendered).toContain('runtime: inline');
    expect(rendered).toContain('max_turns: 12');
    expect(rendered).toContain('effort: xhigh');
    const roundTripped = parseRuntimeSettings(rendered).agents.main_agent;
    expect(resolveConfiguredAgentRuntime(roundTripped)).toBe('inline');
    expect(roundTripped).toMatchObject({ maxTurns: 12, effort: 'xhigh' });
  });

  it.each([
    ['max_turns: 0', 'agents.main_agent.max_turns must be a positive integer'],
    ['max_turns: -1', 'agents.main_agent.max_turns must be a positive integer'],
    [
      'effort: extreme',
      'agents.main_agent.effort must be one of low, medium, high, xhigh, max',
    ],
  ])('rejects invalid inline iteration setting %s', (setting, error) => {
    expect(() =>
      parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
    ${setting}
`),
    ).toThrow(error);
  });

  it('leaves worker execution selected when iteration settings are present', () => {
    const parsed = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: worker
    max_turns: 8
    effort: low
`);

    expect(resolveConfiguredAgentRuntime(parsed.agents.main_agent)).toBe(
      'worker',
    );
    expect(parsed.agents.main_agent).toMatchObject({
      maxTurns: 8,
      effort: 'low',
    });
  });

  it('rejects inline agents while naming worker-only configured capabilities', () => {
    expect(() =>
      parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
    model: gpt
    access:
      sources:
        skills:
          - id: skill:writer
        tools:
          - id: acme-cli
            kind: local_cli
      selections:
        - id: RunCommand(npm test *)
          version: builtin
        - id: FileRead
          version: builtin
        - id: Browser
          version: builtin
`),
    ).toThrow(
      'agents.main_agent.runtime inline is incompatible with worker-only capabilities: Browser, FileRead, RunCommand(npm test *), acme-cli',
    );
  });

  it('allows inline attached skills on a DeepAgents model route', () => {
    const parsed = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
    model: kimi
    one_time_job_default_model: kimi
    recurring_job_default_model: kimi
    access:
      sources:
        skills:
          - id: skill:writer
`);

    expect(parsed.agents.main_agent.sources.skills[0]?.id).toBe('skill:writer');
  });

  it.each([
    ['one_time_job_default_model', 'one_time_job_default_model: opus'],
    ['recurring_job_default_model', 'recurring_job_default_model: opus'],
  ])('rejects inline attached skills on a non-DeepAgents %s', (_, setting) => {
    expect(() =>
      parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
    model: kimi
    ${setting}
    access:
      sources:
        skills:
          - id: skill:writer
`),
    ).toThrow(
      `agents.main_agent.runtime inline supports attached skills only with engine ${DEEPAGENTS_ENGINE}; model opus resolved engine ${DEFAULT_AGENT_ENGINE} is incompatible with attached skills: skill:writer`,
    );
  });

  it('uses the global model default for inline skill admission', () => {
    const parsed = parseRuntimeSettings(`agent:
  default_model: kimi
  one_time_job_default_model: kimi
  recurring_job_default_model: kimi
agents:
  main_agent:
    name: Main
    runtime: inline
    access:
      sources:
        skills:
          - id: skill:writer
`);

    expect(parsed.agents.main_agent.sources.skills[0]?.id).toBe('skill:writer');
  });

  it('rejects inline attached skills on the default engine model route', () => {
    expect(() =>
      parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
    model: opus
    access:
      sources:
        skills:
          - id: skill:writer
`),
    ).toThrow(
      `agents.main_agent.runtime inline supports attached skills only with engine ${DEEPAGENTS_ENGINE}; model opus resolved engine ${DEFAULT_AGENT_ENGINE} is incompatible with attached skills: skill:writer`,
    );
  });

  it('rejects inline attached skills on a non-DeepAgents global job default', () => {
    expect(() =>
      parseRuntimeSettings(`agent:
  default_model: kimi
  one_time_job_default_model: opus
  recurring_job_default_model: kimi
agents:
  main_agent:
    name: Main
    runtime: inline
    access:
      sources:
        skills:
          - id: skill:writer
`),
    ).toThrow(
      `agents.main_agent.runtime inline supports attached skills only with engine ${DEEPAGENTS_ENGINE}; model opus resolved engine ${DEFAULT_AGENT_ENGINE} is incompatible with attached skills: skill:writer`,
    );
  });

  it('rejects a worker to inline flip while worker-only capabilities are held', () => {
    const worker = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: worker
    access:
      selections:
        - id: FileWrite
          version: builtin
`);
    expect(resolveConfiguredAgentRuntime(worker.agents.main_agent)).toBe(
      'worker',
    );

    expect(() =>
      parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
    access:
      selections:
        - id: FileWrite
          version: builtin
`),
    ).toThrow('worker-only capabilities: FileWrite');
  });

  it('allows an inline to worker flip with worker-only capabilities still held', () => {
    const parsed = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: worker
    access:
      sources:
        skills:
          - id: skill:writer
      selections:
        - id: RunCommand(npm test *)
          version: builtin
`);
    expect(resolveConfiguredAgentRuntime(parsed.agents.main_agent)).toBe(
      'worker',
    );
    expect(parsed.agents.main_agent.sources.skills[0]?.id).toBe('skill:writer');
  });

  it('rejects inline settings apply when an attached MCP source is stdio', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      runtime: 'inline',
      bindings: {},
      sources: {
        ...emptySources(),
        mcpServers: [{ id: 'mcp:stdio-crm' }],
      },
      capabilities: [],
      accessPreset: 'full',
    };
    const service = settingsDesiredStateService();

    await expect(
      service.validateCapabilityReferences(settings),
    ).resolves.toEqual([
      'agents.main_agent.runtime inline is incompatible with worker-only capabilities: mcp:stdio-crm',
    ]);
  });

  it('reuses model-route skill admission during settings apply', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agent.defaultModel = 'gpt';
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      runtime: 'inline',
      bindings: {},
      sources: {
        ...emptySources(),
        skills: [{ id: installedSkill.id }],
      },
      capabilities: [],
      accessPreset: 'full',
    };
    const service = settingsDesiredStateService();

    await expect(
      service.validateCapabilityReferences(settings),
    ).resolves.toEqual([]);

    settings.agent.defaultModel = 'opus';
    await expect(
      service.validateCapabilityReferences(settings),
    ).resolves.toContain(
      `agents.main_agent.runtime inline supports attached skills only with engine ${DEEPAGENTS_ENGINE}; model opus resolved engine ${DEFAULT_AGENT_ENGINE} is incompatible with attached skills: skill:writer`,
    );

    settings.agent.defaultModel = 'kimi';
    settings.agent.oneTimeJobDefaultModel = 'opus';
    await expect(
      service.validateCapabilityReferences(settings),
    ).resolves.toContain(
      `agents.main_agent.runtime inline supports attached skills only with engine ${DEEPAGENTS_ENGINE}; model opus resolved engine ${DEFAULT_AGENT_ENGINE} is incompatible with attached skills: skill:writer`,
    );
  });
});
