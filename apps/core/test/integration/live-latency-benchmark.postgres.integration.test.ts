import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { buildDeepAgentStartupDiagnosticEvent } from '@core/adapters/llm/deepagents-langchain/runner/startup-diagnostic.js';
import type { AppId } from '@core/domain/app/app.js';
import type {
  AgentRunId,
  RuntimeEventPublishInput,
} from '@core/domain/events/events.js';
import { DEEPAGENTS_ENGINE } from '@core/shared/agent-engine.js';
import { buildRunnerHostStartupDiagnosticEvent } from '@core/runtime/agent-spawn-startup-diagnostic.js';
import { publishRunnerProcessStartupDiagnostic } from '@core/runtime/agent-spawn-process-diagnostic.js';
import type { RunnerProcessSpec } from '@core/runtime/agent-spawn-types.js';

import {
  LIVE_LATENCY_BENCHMARK_METRIC_NAMES,
  loadLiveLatencyStartupDiagnosticsFromRuntimeEvents,
  runSyntheticLiveLatencyBenchmark,
} from '../harness/live-latency-benchmark.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const BENCHMARK_RUN_ID = 'live-latency-benchmark-itest';
const BENCHMARK_PROVIDER_CONNECTION_ID =
  'provider-connection:live-latency-benchmark';
const BENCHMARK_CONVERSATION_ID = 'conversation:live-latency-benchmark';

function itemRunIdsByItemId(
  benchmarkRunId: string,
  concurrency: number,
): Map<string, string> {
  return new Map(
    Array.from({ length: concurrency }, (_, index) => [
      `${benchmarkRunId}:admission:${index}`,
      `agent-run:${benchmarkRunId}:${index}`,
    ]),
  );
}

async function publishStartupDiagnostics(input: {
  runtime: PostgresIntegrationRuntime;
  appId: AppId;
  runId: string;
}): Promise<void> {
  const publishRuntimeEvent = (event: RuntimeEventPublishInput) =>
    input.runtime.storageRuntime.runtimeEvents.publish(event);
  await publishRuntimeEvent(
    buildRunnerHostStartupDiagnosticEvent({
      appId: input.appId,
      agentId: DEFAULT_AGENT_ID,
      runId: input.runId,
      conversationId: BENCHMARK_CONVERSATION_ID,
      agentEngine: DEEPAGENTS_ENGINE,
      executionProviderId: 'deepagents:langchain',
      hostPhases: {
        mcpProjectionMs: 12,
        sandboxSpecMs: 4,
      },
      toolPolicyRuleCount: 0,
      gantryMcpToolCount: 0,
      attachedMcpSourceCount: 0,
      projectedMcpSourceCount: 0,
      selectedMcpServerCount: 0,
      materializedMcpServerCount: 0,
      runnerVisibleMcpServerCount: 0,
      reviewedMcpToolCount: 0,
      mcpConfigProjected: false,
      mcpTransportCounts: { stdio: 0, http: 0, sse: 0 },
      selectedSkillSourceCount: 0,
      selectedSkillDisplayCount: 0,
      selectedSkillSecretEnvCount: 0,
      semanticCapabilityCount: 0,
      runtimeAccessCount: 0,
      browserIpcEnabled: false,
      memoryIpcActionCount: 0,
      deepAgentCheckpointerConfigured: true,
      sandbox: {
        provider: 'direct',
        enforcing: false,
        allowedNetworkHostCount: 0,
        protectedReadPathCount: 0,
        protectedWritePathCount: 0,
        localCliCredentialPathCount: 0,
        warmTemplateAvailable: false,
        warmTemplateCacheHit: false,
      },
      egress: {
        proxyConfigured: false,
        upstreamProxyConfigured: false,
      },
      credentials: {
        brokerApplied: true,
        credentialProviderCount: 1,
        modelCredentialEnvKeyCount: 1,
      },
      prompt: {
        compiledSystemPromptChars: 0,
      },
    }),
  );
  await publishRuntimeEvent(
    buildDeepAgentStartupDiagnosticEvent({
      agentInput: {
        appId: input.appId,
        agentId: DEFAULT_AGENT_ID,
        runId: input.runId,
        prompt: 'benchmark',
        workspaceFolder: '/tmp/gantry-live-latency-benchmark',
        chatJid: BENCHMARK_CONVERSATION_ID,
      },
      modelProvider: 'openai',
      modelId: 'benchmark-model',
      endpointFamily: 'openai',
      timing: {
        totalMs: 40,
        firstVisibleOutputMs: 21,
        toolStartCount: 0,
        phases: {
          modelBuildMs: 3,
          mcpConnectMs: 5,
          permissionEnvMs: 1,
        },
      },
      selectedAllowedToolCount: 0,
      connectedToolCount: 0,
      systemPromptChars: 0,
      memoryContextChars: 0,
      turnMessageCount: 1,
      cacheMode: 'none',
      checkpointerConfigured: true,
      checkpointTiming: {
        loadCount: 1,
        loadMs: 9,
        writeCount: 1,
        writeMs: 18,
      },
      scheduledJob: false,
    }) as RuntimeEventPublishInput,
  );
  const runnerProcessEvents: Promise<unknown>[] = [];
  publishRunnerProcessStartupDiagnostic({
    spec: {
      input: {
        appId: input.appId,
        agentId: DEFAULT_AGENT_ID,
        runId: input.runId,
        prompt: 'benchmark',
        workspaceFolder: '/tmp/gantry-live-latency-benchmark',
        chatJid: BENCHMARK_CONVERSATION_ID,
      },
      options: {
        publishRuntimeEvent: (event) => {
          const published = publishRuntimeEvent(event);
          runnerProcessEvents.push(published);
          return published;
        },
        runnerSandboxProvider: {
          id: 'direct',
          enforcing: false,
        },
      },
    } as RunnerProcessSpec,
    code: 0,
    signal: null,
    hadStreamingOutput: true,
    timedOut: false,
    timeoutReason: 'timeout',
    startupTiming: {
      hostPreSpawnMs: 1,
      sandboxStartCallMs: 6,
      firstVisibleOutputMs: 31,
      hostPhases: {
        mcpProjectionMs: 12,
        sandboxSpecMs: 4,
      },
    },
  });
  await Promise.all(runnerProcessEvents);
}

maybeDescribe('live latency benchmark (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'live_latency_benchmark',
    });
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('rolls up 300 durable live admissions with required startup and UX fields', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    await runtime.repositories.providerConnections.saveProviderConnection({
      id: BENCHMARK_PROVIDER_CONNECTION_ID as never,
      appId,
      providerId: 'telegram' as never,
      externalInstallationRef: {
        kind: 'provider_connection',
        value: BENCHMARK_PROVIDER_CONNECTION_ID,
      },
      label: 'Live Latency Benchmark',
      status: 'active',
      config: {},
      runtimeSecretRefs: [],
      createdAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:00.000Z',
    });
    await runtime.repositories.conversations.saveConversation({
      id: BENCHMARK_CONVERSATION_ID as never,
      appId,
      providerConnectionId: BENCHMARK_PROVIDER_CONNECTION_ID as never,
      externalRef: { kind: 'conversation', value: BENCHMARK_CONVERSATION_ID },
      kind: 'group',
      title: 'Live Latency Benchmark',
      status: 'active',
      createdAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:00.000Z',
    });
    const runIdsByItemId = itemRunIdsByItemId(BENCHMARK_RUN_ID, 300);
    const now = new Date().toISOString();
    for (const runId of runIdsByItemId.values()) {
      await runtime.repositories.agentRuns.saveAgentRun({
        id: runId as AgentRunId,
        appId,
        agentId: DEFAULT_AGENT_ID as never,
        configVersionId: `config:${DEFAULT_AGENT_ID}:1` as never,
        llmProfileId: DEFAULT_LLM_PROFILE_ID as never,
        executionProviderId: 'deepagents:langchain' as never,
        permissionDecisionIds: [],
        cause: 'message',
        status: 'running',
        createdAt: now,
        startedAt: now,
      });
      await publishStartupDiagnostics({ runtime, appId, runId });
    }
    const startupDiagnosticsByItemId =
      await loadLiveLatencyStartupDiagnosticsFromRuntimeEvents({
        runtimeEvents: runtime.repositories.runtimeEvents,
        appId,
        itemRunIdsByItemId: runIdsByItemId,
      });
    const reportArtifactPath = path.join(
      runtime.artifactRoot,
      'reports',
      `${BENCHMARK_RUN_ID}.json`,
    );

    const report = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: runtime.repositories.liveTurns,
      concurrency: 300,
      workerCount: 12,
      claimBatchSize: 25,
      firstVisibleSloMs: 5_000,
      benchmarkRunId: BENCHMARK_RUN_ID,
      startupDiagnosticsByItemId,
      reportArtifactPath,
      syntheticLatenciesMs: {
        hydrationLagMs: 1,
        bridgeLagMs: 1,
        checkpointLoadMs: 2,
        checkpointWriteMs: 3,
        asyncDelegationLaunchAckMs: 1,
        delegationProgressEventMs: 1,
        streamRejoinMs: 1,
        queuedInputWakeMs: 1,
        mcpClientStartupMs: 2,
        toolListingFilteringMs: 2,
        toolSchemaSerializationMs: 2,
        permissionHitlSetupMs: 1,
        sandboxReadinessMs: 1,
        sandboxTemplateMs: 1,
        sandboxSpecMs: 1,
        sandboxStartMs: 1,
        sandboxFirstToolReadyMs: 1,
        modelConstructionMs: 2,
        notifyLagMs: 0,
      },
      sleepMs: async () => undefined,
    });

    expect(report.sampleCount).toBe(300);
    expect(report.concurrency).toBe(300);
    expect(Object.keys(report.metrics).sort()).toEqual(
      [...LIVE_LATENCY_BENCHMARK_METRIC_NAMES].sort(),
    );
    for (const metricName of LIVE_LATENCY_BENCHMARK_METRIC_NAMES) {
      expect(report.metrics[metricName].count).toBe(300);
      expect(report.metrics[metricName].p50).not.toBeNull();
      expect(report.metrics[metricName].p95).not.toBeNull();
      expect(report.metrics[metricName].p99).not.toBeNull();
    }

    expect(report.metrics.acceptedToFirstVisibleMs.p95).toBeLessThanOrEqual(
      5_000,
    );
    expect(report.metrics.checkpointLoadMs).toMatchObject({
      p95: 9,
      source: 'measured',
    });
    expect(report.metrics.checkpointWriteMs).toMatchObject({
      p95: 18,
      source: 'measured',
    });
    expect(report.metrics.mcpClientStartupMs).toMatchObject({
      p95: 5,
      source: 'synthetic',
    });
    expect(report.metrics.toolListingFilteringMs).toMatchObject({
      p95: 12,
      source: 'synthetic',
    });
    expect(report.metrics.sandboxSpecMs).toMatchObject({
      p95: 4,
      source: 'synthetic',
    });
    expect(report.metrics.sandboxStartMs).toMatchObject({
      p95: 6,
      source: 'synthetic',
    });
    expect(report.syntheticMetricNames).not.toContain('checkpointLoadMs');
    expect(report.syntheticMetricNames).toContain('sandboxStartMs');
    expect(report.measuredMetricNames).toContain('admissionLagMs');
    expect(report.measuredMetricNames).toContain('checkpointLoadMs');
    expect(report.measuredMetricNames).not.toContain('sandboxStartMs');
    expect(report.readiness.passed).toBe(false);
    expect(report.readiness.failedMetricNames).toEqual(
      expect.arrayContaining([
        'acceptedToFirstVisibleMs',
        'mcpClientStartupMs',
        'toolListingFilteringMs',
        'permissionHitlSetupMs',
        'sandboxSpecMs',
        'sandboxStartMs',
        'modelConstructionMs',
      ]),
    );
    expect(report.readiness.failureReasons).toEqual(
      expect.arrayContaining(['synthetic_metric', 'untrusted_evidence_source']),
    );
    const fixtureSeededStartupReadinessMetrics = [
      'acceptedToFirstVisibleMs',
      'mcpClientStartupMs',
      'toolListingFilteringMs',
      'permissionHitlSetupMs',
      'sandboxSpecMs',
      'sandboxStartMs',
      'modelConstructionMs',
    ] as const;
    for (const metricName of fixtureSeededStartupReadinessMetrics) {
      expect(report.readiness.metrics[metricName]).toMatchObject({
        source: 'synthetic',
        count: 300,
        evidenceSourceCounts: {
          fixture_seeded: 300,
        },
        failureReasons: expect.arrayContaining([
          'synthetic_metric',
          'untrusted_evidence_source',
        ]),
      });
    }
    expect(report.deferredCount).toBe(0);
    expect(report.degradedCount).toBe(0);
    expect(report.failureCount).toBe(0);
    expect(report.missingMetricNames).toEqual([]);

    const artifact = JSON.parse(fs.readFileSync(reportArtifactPath, 'utf8'));
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      benchmarkRunId: BENCHMARK_RUN_ID,
      report: {
        sampleCount: 300,
        measuredMetricNames: expect.arrayContaining(['checkpointLoadMs']),
        syntheticMetricNames: expect.not.arrayContaining(['checkpointLoadMs']),
        readiness: {
          passed: false,
          failedMetricNames: expect.arrayContaining([
            'acceptedToFirstVisibleMs',
            'sandboxStartMs',
          ]),
        },
      },
    });
    expect(artifact.generatedAt).toEqual(expect.any(String));
    expect(artifact.report.metrics.sandboxStartMs).toMatchObject({
      p95: 6,
      source: 'synthetic',
    });
  });
});
