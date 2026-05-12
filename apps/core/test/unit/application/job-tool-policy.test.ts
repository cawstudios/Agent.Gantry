import { describe, expect, it } from 'vitest';

import { resolveJobToolPolicy } from '@core/application/jobs/job-tool-policy.js';
import type { Job } from '@core/domain/types.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-browser-intent',
    name: 'Browser job',
    prompt: 'navigate to https://example.com in the browser',
    schedule_type: 'once',
    schedule_value: '2026-05-09T00:00:00.000Z',
    status: 'active',
    session_id: null,
    thread_id: null,
    group_scope: 'team',
    created_by: 'agent',
    created_at: '2026-05-09T00:00:00.000Z',
    updated_at: '2026-05-09T00:00:00.000Z',
    next_run: null,
    last_run: null,
    silent: false,
    cleanup_after_ms: 86_400_000,
    timeout_ms: 300_000,
    max_retries: 1,
    retry_backoff_ms: 1,
    max_consecutive_failures: 3,
    consecutive_failures: 0,
    execution_mode: 'serialized',
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    ...overrides,
  };
}

function toolRepositoryFor(names: string[]) {
  return {
    listAgentToolBindings: async () =>
      names.map((name) => ({ toolId: `tool:${name}`, status: 'active' })),
    getTool: async (toolId: string) => ({
      id: toolId,
      appId: 'default',
      name: toolId.replace(/^tool:/, ''),
    }),
  } as never;
}

describe('job tool policy', () => {
  it('resolves scheduled job tools from the target agent only', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['Browser']),
      }),
    ).resolves.toEqual({
      inheritedTools: ['Browser'],
      effectiveAllowedTools: ['Browser'],
    });
  });

  it('rejects stale inherited agent_browser MCP rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['mcp__agent_browser__*']),
      }),
    ).rejects.toThrowError(/canonical Browser tool capability/);
  });

  it('rejects stale inherited projected browser MCP rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['mcp__myclaw__browser_click']),
      }),
    ).rejects.toThrowError(/runtime projections, not durable capabilities/);
  });

  it('rejects stale inherited MyClaw MCP wildcard rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['mcp__myclaw__*']),
      }),
    ).rejects.toThrowError(/wildcard grants are not supported/);
  });
});
