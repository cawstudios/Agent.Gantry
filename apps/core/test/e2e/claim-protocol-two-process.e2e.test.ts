import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as pgSchema from '@core/adapters/storage/postgres/schema/index.js';
import type { AgentExecutionAdapter } from '@core/application/agent-execution/agent-execution-adapter.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
import type { ConversationRoute } from '@core/domain/types.js';
import { nowIso } from '@core/shared/time/datetime.js';

import { createFakeChannelRuntime } from '../harness/fake-channel.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const tsxBin = path.join(repoRoot, 'node_modules/.bin/tsx');
const workerScript = path.join(here, 'fixtures', 'worker-claim-process.ts');

interface WorkerOutcome {
  marker: 'CHAOS_WORKER';
  workerInstanceId?: string;
  claimed?: boolean;
  fencingVersion?: number;
  completed?: boolean;
  error?: string;
}

/**
 * Spawn the worker fixture as a real, separate OS process. Returns the parsed
 * single-line JSON outcome (plus raw output for diagnostics).
 */
function spawnWorker(env: Record<string, string>): Promise<{
  outcome: WorkerOutcome | null;
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [workerScript], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse()
        .find((l) => l.includes('"marker":"CHAOS_WORKER"'));
      let outcome: WorkerOutcome | null = null;
      if (line) {
        try {
          outcome = JSON.parse(line) as WorkerOutcome;
        } catch {
          outcome = null;
        }
      }
      resolve({ outcome, code, stdout, stderr });
    });
  });
}

function makeJob(id: string): JobUpsertInput {
  const now = nowIso();
  return {
    id,
    name: `Job ${id}`,
    prompt: 'Two-process claim e2e',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    session_id: null,
    thread_id: null,
    execution_context: {
      conversationJid: 'tg:two-process-claim',
      threadId: null,
      workspaceKey: 'scheduler_agent',
      sessionId: null,
    },
    workspace_key: 'scheduler_agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: null,
    silent: true,
    timeout_ms: 30_000,
    max_retries: 1,
    retry_backoff_ms: 1,
  } satisfies JobUpsertInput;
}

maybeDescribe('two-process worker claim protocol (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  const jobId = 'job-two-process-claim';
  const runId = 'run-two-process-claim';

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'two_proc_claim',
    });
    // Two separate worker instances compete for one run.
    await runtime.repositories.workerCoordination.registerWorker({
      id: 'proc-worker-a',
      bootNonce: 'nonce-a',
    });
    await runtime.repositories.workerCoordination.registerWorker({
      id: 'proc-worker-b',
      bootNonce: 'nonce-b',
    });
    // Seed only the runnable job. The run row itself is created transactionally
    // by the winning worker's claimDueJobRunStart (the production scheduler claim
    // path), so the run never exists without a confirmed claim.
    await runtime.ops.upsertJob(makeJob(jobId));
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it(
    'two separate OS worker processes race the claim; exactly one wins and ' +
      'durably completes the run',
    async () => {
      const databaseUrl = process.env.GANTRY_TEST_DATABASE_URL ?? '';
      const schema = runtime.schemaName;
      // Shared wall-clock barrier so both processes attempt the claim in the same
      // window when timing permits — giving genuine concurrent-claim coverage on
      // top of the protocol's own guarantee. Correctness does NOT depend on the
      // barrier: claimDueJobRunStart refuses the loser whether it arrives while
      // the winner's lease is active (claimed-elsewhere) or after the winner
      // finished (terminal run row), so the assertions hold at any interleaving.
      const startAtMs = String(Date.now() + 1_500);

      const baseEnv = {
        GANTRY_TEST_DATABASE_URL: databaseUrl,
        CHAOS_SCHEMA: schema,
        CHAOS_RUN_ID: runId,
        CHAOS_JOB_ID: jobId,
        CHAOS_START_AT_MS: startAtMs,
      };

      const [a, b] = await Promise.all([
        spawnWorker({ ...baseEnv, CHAOS_WORKER_INSTANCE_ID: 'proc-worker-a' }),
        spawnWorker({ ...baseEnv, CHAOS_WORKER_INSTANCE_ID: 'proc-worker-b' }),
      ]);

      // Both processes exited cleanly with a parseable outcome.
      expect(a.code, `worker A stderr:\n${a.stderr}`).toBe(0);
      expect(b.code, `worker B stderr:\n${b.stderr}`).toBe(0);
      expect(a.outcome, `worker A stdout:\n${a.stdout}`).not.toBeNull();
      expect(b.outcome, `worker B stdout:\n${b.stdout}`).not.toBeNull();
      expect(a.outcome?.error).toBeUndefined();
      expect(b.outcome?.error).toBeUndefined();

      // Exactly one process claimed the run; the other was refused.
      const claims = [a.outcome, b.outcome].filter((o) => o?.claimed === true);
      const refusals = [a.outcome, b.outcome].filter(
        (o) => o?.claimed === false,
      );
      expect(claims).toHaveLength(1);
      expect(refusals).toHaveLength(1);

      // The winner held fencing version 1 (first claim on a fresh run) and the
      // lease-fenced terminal write succeeded.
      expect(claims[0]?.fencingVersion).toBe(1);
      expect(claims[0]?.completed).toBe(true);

      // Terminal state is DURABLY visible from the parent process: the run row is
      // `completed` and stamped by the winning worker.
      const finalRun = await runtime.ops.getJobRunById(runId);
      expect(finalRun?.status).toBe('completed');
      expect(finalRun?.result_summary).toBe(
        `completed by ${claims[0]?.workerInstanceId}`,
      );

      // The active lease is settled — no live lease lingers after completion.
      const activeLease =
        await runtime.repositories.workerCoordination.getActiveRunLease({
          runId,
        });
      expect(activeLease).toBeNull();
    },
    60_000,
  );
});

interface LiveTempRuntime {
  root: string;
  runtimeHome: string;
  dataDir: string;
  agentRoot: string;
  groupDir: string;
  workspaceIpcDir: string;
  runnerDistDir: string;
  runnerPath: string;
  recordPath: string;
}

const liveTempRuntimes: LiveTempRuntime[] = [];

function makeLiveTempRuntime(folder: string): LiveTempRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-live-e2e-'));
  const runtimeHome = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const agentRoot = path.join(runtimeHome, 'agents');
  const groupDir = path.join(agentRoot, folder);
  const workspaceIpcDir = path.join(dataDir, 'ipc', folder);
  const runnerDistDir = path.join(root, 'dist', 'runner');
  const runnerPath = path.join(runnerDistDir, 'live-e2e-runner.cjs');
  const recordPath = path.join(root, 'child-record.json');
  fs.mkdirSync(path.join(runnerDistDir, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(runnerDistDir, 'mcp', 'stdio.js'), '');
  const temp = {
    root,
    runtimeHome,
    dataDir,
    agentRoot,
    groupDir,
    workspaceIpcDir,
    runnerDistDir,
    runnerPath,
    recordPath,
  };
  liveTempRuntimes.push(temp);
  return temp;
}

function writeLiveDeterministicRunner(temp: LiveTempRuntime): void {
  fs.writeFileSync(
    temp.runnerPath,
    `
const fs = require('node:fs');

let stdin = '';
process.stdin.on('data', (chunk) => {
  stdin += chunk.toString();
});
process.stdin.on('end', () => {
  const input = JSON.parse(stdin);
  fs.writeFileSync(
    ${JSON.stringify(temp.recordPath)},
    JSON.stringify({
      input,
      env: {
        groupDir: process.env.GANTRY_WORKSPACE_GROUP_DIR,
        ipcDir: process.env.GANTRY_IPC_DIR,
        authTokenPresent: Boolean(process.env.GANTRY_IPC_AUTH_TOKEN),
      },
    }, null, 2),
  );
  console.log('---GANTRY_OUTPUT_START---');
  console.log(JSON.stringify({
    status: 'success',
    result: 'live e2e child saw: ' + input.prompt,
    newSessionId: 'live-e2e-session',
  }));
  console.log('---GANTRY_OUTPUT_END---');
});
`,
  );
}

async function waitForLiveE2e(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function removeLiveTempRuntime(temp: LiveTempRuntime): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: string }).code)
          : '';
      if (code !== 'ENOTEMPTY' || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

maybeDescribe('live turn real runner (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let queue:
    | {
        enqueueMessageCheck(groupJid: string): boolean;
        shutdown(ms: number): Promise<void>;
      }
    | undefined;
  let previousGantryHome: string | undefined;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'live_turn_real_runner',
    });
    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);
  }, 60_000);

  afterAll(async () => {
    await queue?.shutdown(500);
    vi.doUnmock('@core/config/index.js');
    vi.doUnmock('@core/runtime/agent-spawn-host.js');
    vi.doUnmock('@core/application/agents/prompt-profile-service.js');
    vi.resetModules();
    if (previousGantryHome === undefined) delete process.env.GANTRY_HOME;
    else process.env.GANTRY_HOME = previousGantryHome;
    if (previousDatabaseUrl === undefined)
      delete process.env.GANTRY_DATABASE_URL;
    else process.env.GANTRY_DATABASE_URL = previousDatabaseUrl;
    await runtime?.cleanup();
    for (const temp of liveTempRuntimes.splice(0)) {
      await removeLiveTempRuntime(temp);
    }
  });

  it('processes one inbound message through the app queue and a spawned child runner', async () => {
    vi.resetModules();
    previousGantryHome = process.env.GANTRY_HOME;
    previousDatabaseUrl = process.env.GANTRY_DATABASE_URL;

    const folder = 'live_e2e_agent';
    const chatJid = 'tg:live-e2e-real-runner';
    const inboundText = 'please run the live e2e';
    const temp = makeLiveTempRuntime(folder);
    writeLiveDeterministicRunner(temp);
    process.env.GANTRY_HOME = temp.runtimeHome;
    process.env.GANTRY_DATABASE_URL = process.env.GANTRY_TEST_DATABASE_URL;

    vi.doMock('@core/config/index.js', async () => {
      const actual = await vi.importActual<
        typeof import('@core/config/index.js')
      >('@core/config/index.js');
      const settings = actual.createDefaultRuntimeSettings();
      const liveE2eHarness = ['anthropic', 'sdk'].join(
        '_',
      ) as typeof settings.agent.agentHarness;
      settings.storage.postgres.urlEnv = 'GANTRY_TEST_DATABASE_URL';
      settings.storage.postgres.schema = runtime.schemaName;
      settings.credentialBroker.mode = 'none';
      settings.agent.defaultModel = 'opus';
      settings.agent.agentHarness = liveE2eHarness;
      settings.runtime.queue.maxMessageRuns = 1;
      settings.runtime.queue.maxRetries = 0;
      settings.runtime.queue.baseRetryMs = 25;
      settings.runtime.sandbox.provider = 'direct';
      return {
        ...actual,
        AGENT_MAX_OUTPUT_SIZE: 1024 * 1024,
        AGENT_TIMEOUT: 5_000,
        DATA_DIR: temp.dataDir,
        AGENTS_DIR: temp.agentRoot,
        GANTRY_HOME: temp.runtimeHome,
        IDLE_TIMEOUT: 5_000,
        PERMISSION_APPROVAL_TIMEOUT_MS: 5_000,
        STORAGE_POSTGRES_SCHEMA: runtime.schemaName,
        STORAGE_POSTGRES_URL: process.env.GANTRY_TEST_DATABASE_URL ?? '',
        STORAGE_POSTGRES_URL_ENV: 'GANTRY_TEST_DATABASE_URL',
        getEffectiveModelConfig: () => ({
          model: 'opus',
          source: 'test runtime default',
        }),
        getRuntimeSettingsForConfig: () => settings,
        getSelectedAgentHarness: () => liveE2eHarness,
      };
    });
    vi.doMock('@core/runtime/agent-spawn-host.js', () => ({
      getHostRuntimeCredentialEnv: async () => ({
        env: {},
        credentialProviders: {},
        brokerApplied: false,
        brokerProfile: 'none',
      }),
      prepareHostRuntimeContext: () => ({
        groupDir: temp.groupDir,
        workspaceIpcDir: temp.workspaceIpcDir,
        runnerDistDir: temp.runnerDistDir,
      }),
    }));
    vi.doMock('@core/application/agents/prompt-profile-service.js', () => {
      class MockPromptProfileService {
        async ensureAgentDefaults(): Promise<void> {}
        async compileSystemPrompt(): Promise<string> {
          return 'compiled live e2e prompt';
        }
      }
      return {
        PromptProfileService: MockPromptProfileService,
        promptProfileAgentIdForFolder: (agentFolder: string) =>
          `agent:${agentFolder}`,
      };
    });

    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);

    const { createRuntimeApp } =
      await import('@core/app/bootstrap/runtime-app.js');
    const { GroupQueue } = await import('@core/runtime/group-queue.js');
    const { createAgentExecutionAdapterRegistry } =
      await import('@core/application/agent-execution/agent-execution-adapter-registry.js');
    const { DirectRunnerSandboxProvider } =
      await import('@core/adapters/sandbox/runner-sandbox-provider.js');

    const executionAdapter: AgentExecutionAdapter = {
      id: 'anthropic:claude-agent-sdk',
      async prepare(input) {
        return {
          providerId: 'anthropic:claude-agent-sdk',
          runnerPath: temp.runnerPath,
          runnerArgs: [temp.runnerPath],
          runnerInputPatch: {
            modelCredentialEnv: { ...input.modelCredentialProjection.env },
          },
          env: {},
          protectedFilesystemPaths: [],
          runtimeDetails: ['executionProvider=anthropic:claude-agent-sdk'],
          cleanup: () => {},
        };
      },
    };

    const messageQueue = new GroupQueue({
      maxMessageRuns: 1,
      maxJobRuns: 1,
      maxRetries: 0,
      baseRetryMs: 25,
    });
    queue = messageQueue;
    const fakeChannel = createFakeChannelRuntime((jid) => jid === chatJid);
    const app = createRuntimeApp({
      queue: messageQueue,
      opsRepository: runtime.ops,
      ensureCredentialBinding: async () => ({ created: false }),
      executionAdapter,
      executionAdapters: createAgentExecutionAdapterRegistry([
        executionAdapter,
      ]),
      runnerSandboxProvider: new DirectRunnerSandboxProvider(),
      publishRuntimeEvent: (event) =>
        runtime.storageRuntime.runtimeEvents.publish(event as never),
    });
    messageQueue.setProcessMessagesFn((groupJid, options) =>
      app.processGroupMessages(groupJid, options),
    );
    app.setChannelRuntime(fakeChannel.runtime);

    const route: ConversationRoute = {
      name: 'Live E2E Agent',
      folder,
      trigger: 'Andy',
      added_at: nowIso(),
      requiresTrigger: false,
      conversationKind: 'dm',
      agentConfig: { model: 'opus', timeout: 5_000 },
    };
    await app.registerGroup(chatJid, route);
    await runtime.ops.storeMessage({
      id: 'msg-live-e2e-real-runner',
      chat_jid: chatJid,
      provider: 'telegram',
      sender: 'user-live-e2e',
      sender_name: 'Live E2E User',
      content: inboundText,
      timestamp: nowIso(),
      is_from_me: false,
      is_bot_message: false,
      external_message_id: 'telegram-live-e2e-real-runner-1',
    });

    expect(messageQueue.enqueueMessageCheck(chatJid)).toBe(true);

    await waitForLiveE2e(
      () =>
        fakeChannel.outbound.some((message) =>
          message.text.includes('live e2e child saw:'),
        ),
      'final outbound message',
    );

    const finalText = fakeChannel.outbound
      .map((message) => message.text)
      .join('\n');
    expect(finalText).toContain('live e2e child saw:');
    expect(finalText).toContain(inboundText);

    const childRecord = JSON.parse(
      fs.readFileSync(temp.recordPath, 'utf-8'),
    ) as {
      input: Record<string, unknown>;
      env: Record<string, unknown>;
    };
    expect(childRecord.input).toEqual(
      expect.objectContaining({
        chatJid,
        compiledSystemPrompt: 'compiled live e2e prompt',
        workspaceFolder: folder,
      }),
    );
    expect(childRecord.input.prompt).toEqual(
      expect.stringContaining(inboundText),
    );
    expect(childRecord.env).toEqual(
      expect.objectContaining({
        groupDir: temp.groupDir,
        ipcDir: temp.workspaceIpcDir,
        authTokenPresent: true,
      }),
    );
    expect(childRecord.input.modelCredentialEnv).toEqual({});

    const routes = await runtime.ops.getAllConversationRoutes();
    expect(routes[chatJid]).toEqual(
      expect.objectContaining({
        agentConfig: route.agentConfig,
        conversationKind: route.conversationKind,
        folder: route.folder,
        name: route.name,
        requiresTrigger: route.requiresTrigger,
        trigger: route.trigger,
      }),
    );
    const cursorState = JSON.parse(
      (await runtime.ops.getRouterState('last_agent_timestamp')) ?? '{}',
    ) as Record<string, string>;
    expect(JSON.parse(cursorState[chatJid] ?? '{}')).toEqual(
      expect.objectContaining({ id: 'msg-live-e2e-real-runner' }),
    );

    const runs = await runtime.service.db
      .select({
        id: pgSchema.agentRunsPostgres.id,
        status: pgSchema.agentRunsPostgres.status,
        providerSessionId: pgSchema.agentRunsPostgres.providerSessionId,
        resultSummary: pgSchema.agentRunsPostgres.resultSummary,
      })
      .from(pgSchema.agentRunsPostgres);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(
      expect.objectContaining({
        status: 'completed',
        providerSessionId: 'live-e2e-session',
      }),
    );
    expect(runs[0]?.resultSummary).toContain('live e2e child saw:');

    const providerSessions = await runtime.service.db
      .select({
        externalSessionId: pgSchema.providerSessionsPostgres.externalSessionId,
        status: pgSchema.providerSessionsPostgres.status,
      })
      .from(pgSchema.providerSessionsPostgres)
      .where(
        eq(
          pgSchema.providerSessionsPostgres.externalSessionId,
          'live-e2e-session',
        ),
      );
    expect(providerSessions).toEqual([
      { externalSessionId: 'live-e2e-session', status: 'active' },
    ]);

    const events = await runtime.repositories.runtimeEvents.listRuntimeEvents({
      appId: 'default' as never,
      runId: runs[0]?.id as never,
    });
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        RUNTIME_EVENT_TYPES.RUN_STARTED,
        RUNTIME_EVENT_TYPES.RUN_COMPLETED,
      ]),
    );
  }, 60_000);
});
