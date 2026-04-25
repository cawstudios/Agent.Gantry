import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getConfiguredAgents,
  refreshConfiguredAgentsFromDisk,
} from './agent-config-registry.js';

function makeTempAgentsDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-agent-registry-'));
  return path.join(root, 'agents');
}

function writeAgentYaml(
  agentsDir: string,
  folder: string,
  content: string,
): string {
  const dir = path.join(agentsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'agent.yaml');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

afterEach(() => {
  refreshConfiguredAgentsFromDisk({
    agentsDir: makeTempAgentsDir(),
    logger: { info: () => undefined, warn: () => undefined },
  });
});

describe('agent-config-registry', () => {
  it('loads valid agents from agents/*/agent.yaml files', () => {
    const agentsDir = makeTempAgentsDir();
    writeAgentYaml(
      agentsDir,
      'people-ops-agent',
      [
        'id: people-ops-agent',
        'channel: slack',
        'timezone: Asia/Kolkata',
        'manager_target: "slack:#hr-managers"',
        'channel_jids:',
        '  - "sl:C0AT4JNGA9Z"',
        'enabled_workflows:',
        '  - attendance-daily',
        '  - attendance-followup',
      ].join('\n'),
    );

    const loaded = refreshConfiguredAgentsFromDisk({
      agentsDir,
      logger: { info: () => undefined, warn: () => undefined },
    });

    expect(Object.keys(loaded)).toEqual(['people-ops-agent']);
    expect(loaded['people-ops-agent']).toMatchObject({
      id: 'people-ops-agent',
      folder: 'people-ops-agent',
      channel: 'slack',
      timezone: 'Asia/Kolkata',
      channelJids: ['sl:C0AT4JNGA9Z'],
      enabledWorkflows: ['attendance-daily', 'attendance-followup'],
    });
    expect(getConfiguredAgents()['people-ops-agent']?.id).toBe(
      'people-ops-agent',
    );
  });

  it('throws a clear validation error for invalid timezone', () => {
    const agentsDir = makeTempAgentsDir();
    writeAgentYaml(
      agentsDir,
      'people-ops-agent',
      ['id: people-ops-agent', 'channel: slack', 'timezone: Not/AZone'].join(
        '\n',
      ),
    );

    expect(() =>
      refreshConfiguredAgentsFromDisk({
        agentsDir,
        logger: { info: () => undefined, warn: () => undefined },
      }),
    ).toThrow(/Invalid agent config/);
  });

  it('throws on duplicate agent ids across folders', () => {
    const agentsDir = makeTempAgentsDir();
    writeAgentYaml(
      agentsDir,
      'people-ops-agent',
      ['id: people-ops-agent', 'channel: slack', 'timezone: Asia/Kolkata'].join(
        '\n',
      ),
    );
    writeAgentYaml(
      agentsDir,
      'people-ops-agent-copy',
      ['id: people-ops-agent', 'channel: slack', 'timezone: Asia/Kolkata'].join(
        '\n',
      ),
    );

    expect(() =>
      refreshConfiguredAgentsFromDisk({
        agentsDir,
        logger: { info: () => undefined, warn: () => undefined },
      }),
    ).toThrow(/Duplicate agent id "people-ops-agent"/);
  });

  it('throws on duplicate channel bindings across agents', () => {
    const agentsDir = makeTempAgentsDir();
    writeAgentYaml(
      agentsDir,
      'people-ops-agent',
      [
        'id: people-ops-agent',
        'channel: slack',
        'timezone: Asia/Kolkata',
        'channel_jids:',
        '  - "sl:C123"',
      ].join('\n'),
    );
    writeAgentYaml(
      agentsDir,
      'finance-agent',
      [
        'id: finance-agent',
        'channel: slack',
        'timezone: Asia/Kolkata',
        'channel_jids:',
        '  - "sl:C123"',
      ].join('\n'),
    );

    expect(() =>
      refreshConfiguredAgentsFromDisk({
        agentsDir,
        logger: { info: () => undefined, warn: () => undefined },
      }),
    ).toThrow(/Duplicate channel_jids entry "sl:C123"/);
  });
});
