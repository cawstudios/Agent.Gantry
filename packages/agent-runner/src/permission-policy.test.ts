import { afterEach, describe, expect, it } from 'vitest';

import {
  checkRunnerToolPermission,
  clearRunnerPermissionRateLimitStateForTest,
  type RunnerPermissionProfile,
} from './permission-policy.js';

function makeProfile(
  overrides: Partial<RunnerPermissionProfile> = {},
): RunnerPermissionProfile {
  return {
    agentId: 'people-ops-agent',
    valid: true,
    tools: {
      bash: true,
      message_send: true,
      message_read: true,
    },
    allowedClis: ['gworkspace', 'slack-cli'],
    requireOnecli: true,
    allowedChannelTargets: { slack: ['#people-ops'] },
    rateLimits: { messagesPerHour: 2 },
    ...overrides,
  };
}

afterEach(() => {
  clearRunnerPermissionRateLimitStateForTest();
});

describe('permission-policy', () => {
  it('allows OneCLI-wrapped allowed Bash commands', () => {
    const decision = checkRunnerToolPermission(
      makeProfile(),
      'Bash',
      { command: 'onecli exec -- gworkspace sheets values get' },
      1000,
    );

    expect(decision).toEqual({ allowed: true });
  });

  it('denies raw CLI commands when OneCLI is required', () => {
    const decision = checkRunnerToolPermission(
      makeProfile(),
      'Bash',
      { command: 'gworkspace sheets values get' },
      1000,
    );

    expect(decision).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('onecli exec --'),
    });
  });

  it('denies CLI commands outside the allowlist', () => {
    const decision = checkRunnerToolPermission(
      makeProfile(),
      'Bash',
      { command: 'onecli exec -- curl https://example.com' },
      1000,
    );

    expect(decision).toMatchObject({
      allowed: false,
      reason: 'CLI curl is not allowed',
    });
  });

  it('denies tools that are not explicitly allowed by profile', () => {
    expect(
      checkRunnerToolPermission(makeProfile(), 'Read', { file_path: 'x' }),
    ).toMatchObject({ allowed: false, reason: 'read is not allowed' });
  });

  it('rate-limits channel send tool usage', () => {
    const profile = makeProfile({ rateLimits: { messagesPerHour: 1 } });

    expect(
      checkRunnerToolPermission(
        profile,
        'mcp__myclaw__send_message',
        { text: 'hello' },
        1000,
      ),
    ).toEqual({ allowed: true });
    expect(
      checkRunnerToolPermission(
        profile,
        'mcp__myclaw__send_message',
        { text: 'again' },
        2000,
      ),
    ).toMatchObject({ allowed: false, reason: expect.stringMatching(/limit/) });
  });

  it('denies every non-internal tool for invalid profiles', () => {
    const decision = checkRunnerToolPermission(
      makeProfile({ valid: false, denyReason: 'permissions.yaml is missing' }),
      'Bash',
      { command: 'onecli exec -- gworkspace whoami' },
      1000,
    );

    expect(decision).toMatchObject({
      allowed: false,
      reason: 'permissions.yaml is missing',
    });
  });
});
