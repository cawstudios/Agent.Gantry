import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkChannelSendPermission,
  clearPermissionRateLimitStateForTest,
  getPermissionProfileForAgent,
  refreshPermissionProfilesFromDisk,
} from './permission-profile-registry.js';
import type { ConfiguredAgent } from './agent-config-registry.js';

function makeTempAgentsDir(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-permission-registry-'),
  );
  return path.join(root, 'agents');
}

function makeAgent(folder = 'people-ops-agent'): ConfiguredAgent {
  return {
    id: folder,
    folder,
    sourcePath: `/tmp/${folder}/agent.yaml`,
    channel: 'slack',
    timezone: 'Asia/Kolkata',
    enabledWorkflows: [],
  };
}

function writePermissionsYaml(
  agentsDir: string,
  folder: string,
  content: string,
): string {
  const dir = path.join(agentsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'permissions.yaml');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

afterEach(() => {
  clearPermissionRateLimitStateForTest();
  refreshPermissionProfilesFromDisk({
    agents: {},
    logger: { info: () => undefined, warn: () => undefined },
  });
});

describe('permission-profile-registry', () => {
  it('loads and normalizes permissions.yaml for configured agents', () => {
    const agentsDir = makeTempAgentsDir();
    const agent = makeAgent();
    writePermissionsYaml(
      agentsDir,
      agent.folder,
      [
        'tools:',
        '  message_send: true',
        '  message_read: true',
        '  bash: false',
        'allowed_clis:',
        '  - gworkspace',
        '  - slack-cli',
        'require_onecli: true',
        'allowed_channel_targets:',
        '  slack:',
        '    - "#hr-managers"',
        '    - "@hr-manager"',
        'rate_limits:',
        '  messages_per_hour: 2',
        '  summaries_per_hour: 10',
      ].join('\n'),
    );

    const loaded = refreshPermissionProfilesFromDisk({
      agentsDir,
      agents: { [agent.id]: agent },
      logger: { info: () => undefined, warn: () => undefined },
    });

    expect(loaded[agent.id]).toMatchObject({
      agentId: 'people-ops-agent',
      valid: true,
      tools: { message_send: true, message_read: true, bash: false },
      allowedClis: ['gworkspace', 'slack-cli'],
      requireOnecli: true,
      allowedChannelTargets: {
        slack: ['#hr-managers', '@hr-manager'],
      },
      rateLimits: {
        messagesPerHour: 2,
        summariesPerHour: 10,
      },
    });
    expect(getPermissionProfileForAgent('people-ops-agent')?.valid).toBe(true);
  });

  it('uses a deny profile when permissions.yaml is missing', () => {
    const agentsDir = makeTempAgentsDir();
    const agent = makeAgent();

    const loaded = refreshPermissionProfilesFromDisk({
      agentsDir,
      agents: { [agent.id]: agent },
      logger: { info: () => undefined, warn: () => undefined },
    });

    expect(loaded[agent.id]).toMatchObject({
      valid: false,
      denyReason: 'permissions.yaml is missing',
      tools: {},
    });
  });

  it('blocks channel sends outside allowed targets and enforces rate limits', () => {
    const agentsDir = makeTempAgentsDir();
    const agent = makeAgent();
    writePermissionsYaml(
      agentsDir,
      agent.folder,
      [
        'tools:',
        '  message_send: true',
        'allowed_channel_targets:',
        '  slack:',
        '    - "#People Ops"',
        'rate_limits:',
        '  messages_per_hour: 1',
      ].join('\n'),
    );
    const profile = refreshPermissionProfilesFromDisk({
      agentsDir,
      agents: { [agent.id]: agent },
      logger: { info: () => undefined, warn: () => undefined },
    })[agent.id];

    expect(
      checkChannelSendPermission(profile, {
        jid: 'sl:C123',
        group: { name: 'People Ops', folder: 'people-ops-agent' },
        nowMs: 1000,
      }),
    ).toEqual({ allowed: true });
    expect(
      checkChannelSendPermission(profile, {
        jid: 'sl:C123',
        group: { name: 'People Ops', folder: 'people-ops-agent' },
        nowMs: 2000,
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringMatching(/limit/) });
    expect(
      checkChannelSendPermission(profile, {
        jid: 'sl:C999',
        group: { name: 'Finance', folder: 'finance' },
        nowMs: 1000,
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('not allowed'),
    });
  });
});
