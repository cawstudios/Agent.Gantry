import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
  EXPECTED_DEEPAGENTS_ASYNC_TOOL_NAMES,
  EXPECTED_DEEPAGENTS_ASYNC_TOOL_SCHEMAS,
  SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION,
  evaluateDeepAgentsAsyncSubagentSentinel,
} from '@core/adapters/llm/deepagents-langchain/runner/async-subagent-sentinel.js';

async function loadDeepAgentsModule(): Promise<Record<string, unknown>> {
  return (await import('deep' + 'agents')) as Record<string, unknown>;
}

function installedDeepAgentsVersion(): string {
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.resolve(process.cwd(), 'node_modules/deepagents/package.json'),
      'utf-8',
    ),
  ) as { version?: unknown };
  return typeof packageJson.version === 'string' ? packageJson.version : '';
}

function fakeDeepAgentsModule(input?: {
  toolNames?: string[];
  schemaPatch?: Record<string, string[]>;
}): Record<string, unknown> {
  const schemaPatch = input?.schemaPatch ?? {};
  return {
    isAsyncSubAgent: (subagent: unknown) =>
      Boolean(
        subagent && typeof subagent === 'object' && 'graphId' in subagent,
      ),
    createAsyncSubAgentMiddleware: () => ({
      name: 'asyncSubAgentMiddleware',
      tools: (input?.toolNames ?? EXPECTED_DEEPAGENTS_ASYNC_TOOL_NAMES).map(
        (name) => ({
          name,
          schema: {
            shape: Object.fromEntries(
              (
                schemaPatch[name] ??
                EXPECTED_DEEPAGENTS_ASYNC_TOOL_SCHEMAS[
                  name as keyof typeof EXPECTED_DEEPAGENTS_ASYNC_TOOL_SCHEMAS
                ] ??
                []
              ).map((key) => [key, {}]),
            ),
          },
        }),
      ),
    }),
  };
}

describe('DeepAgents async subagent sentinel', () => {
  it('detects the installed 1.10.2 async API but fails closed without Gantry transport', async () => {
    expect(installedDeepAgentsVersion()).toBe(
      SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION,
    );

    const result = evaluateDeepAgentsAsyncSubagentSentinel({
      packageVersion: installedDeepAgentsVersion(),
      deepagentsModule: await loadDeepAgentsModule(),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'gantry_transport_unavailable',
      message: DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
      apiCompatible: true,
      packageVersion: SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION,
    });
    expect(result.toolNames?.sort()).toEqual(
      [...EXPECTED_DEEPAGENTS_ASYNC_TOOL_NAMES].sort(),
    );
  });

  it('passes only when the package API and Gantry-owned Agent Protocol transport are ready', async () => {
    const result = evaluateDeepAgentsAsyncSubagentSentinel({
      packageVersion: installedDeepAgentsVersion(),
      deepagentsModule: await loadDeepAgentsModule(),
      gantryAgentProtocolTransportReady: true,
    });

    expect(result).toEqual({
      ok: true,
      packageVersion: SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION,
      toolNames: EXPECTED_DEEPAGENTS_ASYNC_TOOL_NAMES,
      apiCompatible: true,
    });
  });

  it('fails closed when the supported package version drifts', () => {
    const result = evaluateDeepAgentsAsyncSubagentSentinel({
      packageVersion: '1.10.3',
      deepagentsModule: fakeDeepAgentsModule(),
      gantryAgentProtocolTransportReady: true,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'unsupported_package_version',
      message: DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
      packageVersion: '1.10.3',
    });
  });

  it('fails closed when async exports are missing', () => {
    const result = evaluateDeepAgentsAsyncSubagentSentinel({
      packageVersion: SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION,
      deepagentsModule: {},
      gantryAgentProtocolTransportReady: true,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'missing_exports',
      message: DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
      packageVersion: SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION,
    });
  });

  it('fails closed when async tool names drift', () => {
    const result = evaluateDeepAgentsAsyncSubagentSentinel({
      packageVersion: SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION,
      deepagentsModule: fakeDeepAgentsModule({
        toolNames: ['start_async_task', 'check_async_task'],
      }),
      gantryAgentProtocolTransportReady: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'tool_surface_drift',
      message: DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
      apiCompatible: false,
    });
  });

  it('fails closed when async tool schemas drift', () => {
    const result = evaluateDeepAgentsAsyncSubagentSentinel({
      packageVersion: SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION,
      deepagentsModule: fakeDeepAgentsModule({
        schemaPatch: { update_async_task: ['taskId'] },
      }),
      gantryAgentProtocolTransportReady: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'tool_schema_drift',
      message: DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
      apiCompatible: false,
    });
  });
});
