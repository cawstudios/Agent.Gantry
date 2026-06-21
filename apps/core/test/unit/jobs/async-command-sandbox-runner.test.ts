import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ASYNC_RESOURCE_LIMITS,
  buildAsyncCommandEnv,
  runSandboxedAsyncCommand,
} from '@core/jobs/async-command-sandbox-runner.js';
import type {
  RunnerSandboxProvider,
  RunnerSandboxSpawnInput,
} from '@core/shared/runner-sandbox-provider.js';

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

const tempDirs: string[] = [];

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 999_999;
  child.kill = vi.fn(() => true);
  return child;
}

function makeProvider(input?: {
  enforcing?: boolean;
  child?: FakeChild;
  onStart?: (options: RunnerSandboxSpawnInput) => void;
}): { provider: RunnerSandboxProvider; child: FakeChild } {
  const child = input?.child ?? makeChild();
  return {
    child,
    provider: {
      id: input?.enforcing === false ? 'direct' : 'sandbox_runtime',
      enforcing: input?.enforcing ?? true,
      start: vi.fn((options) => {
        input?.onStart?.(options);
        return child as never;
      }),
    },
  };
}

function baseInput(signal = new AbortController().signal) {
  return {
    command: 'echo ok',
    cwd: process.cwd(),
    env: { PATH: '/usr/bin' },
    timeoutMs: 5_000,
    outputMaxBytes: 200,
    protectedReadPaths: ['/secret/read'],
    protectedWritePaths: ['/secret/write'],
    allowedNetworkHosts: ['api.example.com:443'],
    egressProxyUrl: 'http://127.0.0.1:18080',
    resourceLimits: DEFAULT_ASYNC_RESOURCE_LIMITS,
    signal,
    appId: 'app:test',
    agentId: 'agent:test',
    conversationId: 'sl:C123',
    threadId: 'thread-1',
    parentRunId: 'run-1',
    parentJobId: 'job-1',
  };
}

describe('async command sandbox runner', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a narrow child environment without provider credentials', () => {
    vi.stubEnv('PATH', '/safe/bin');
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:18080');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/certs/ca.pem');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-secret');
    vi.stubEnv('OPENAI_API_KEY', 'openai-secret');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-secret');

    expect(buildAsyncCommandEnv()).toMatchObject({
      PATH: '/safe/bin',
      HTTP_PROXY: 'http://127.0.0.1:18080',
      NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
    });
    expect(buildAsyncCommandEnv()).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(buildAsyncCommandEnv()).not.toHaveProperty('OPENAI_API_KEY');
    expect(buildAsyncCommandEnv()).not.toHaveProperty(
      'CLAUDE_CODE_OAUTH_TOKEN',
    );
  });

  it('projects sandbox policy and launch barrier files to the enforcing provider', async () => {
    vi.useFakeTimers();
    const launchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-async-runner-'),
    );
    tempDirs.push(launchDir);
    const launchControl = {
      directory: launchDir,
      pidFile: path.join(launchDir, 'pid'),
      pgidFile: path.join(launchDir, 'pgid'),
      readyFile: path.join(launchDir, 'ready'),
      continueFile: path.join(launchDir, 'continue'),
    };
    const { provider, child } = makeProvider({
      onStart: (options) => {
        fs.writeFileSync(launchControl.readyFile, '');
        expect(options).toMatchObject({
          command: '/bin/sh',
          args: ['-c', expect.stringContaining('GANTRY_ASYNC_COMMAND_SCRIPT')],
          cwd: process.cwd(),
          workspaceRoot: process.cwd(),
          configFilePath: path.join(launchDir, 'sandbox-runtime.json'),
          egressProxyUrl: 'http://127.0.0.1:18080',
          allowedNetworkHosts: ['api.example.com:443'],
          runtimeReadPaths: [process.cwd(), launchDir],
          runtimeWritePaths: [process.cwd(), launchDir],
          protectedReadPaths: ['/secret/read'],
          protectedWritePaths: ['/secret/write'],
          sandboxProfile: {
            id: 'async-command',
            network: 'required',
            filesystem: 'workspace_write',
          },
          principal: {
            appId: 'app:test',
            agentId: 'agent:test',
            conversationId: 'sl:C123',
            threadId: 'thread-1',
            runId: 'run-1',
            jobId: 'job-1',
          },
        });
        expect(options.env).toMatchObject({
          PATH: '/usr/bin',
          GANTRY_ASYNC_COMMAND_SCRIPT: 'echo ok',
          GANTRY_ASYNC_LAUNCH_DIR: launchDir,
          GANTRY_ASYNC_PID_FILE: launchControl.pidFile,
          GANTRY_ASYNC_PGID_FILE: launchControl.pgidFile,
          GANTRY_ASYNC_READY_FILE: launchControl.readyFile,
          GANTRY_ASYNC_CONTINUE_FILE: launchControl.continueFile,
        });
      },
    });

    const resultPromise = runSandboxedAsyncCommand(provider, {
      ...baseInput(),
      launchControl,
    });
    await Promise.resolve();
    child.stdout.write('done\n');
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toEqual({
      outputSummary: 'done',
      errorSummary: '',
    });
    expect(fs.existsSync(launchControl.continueFile)).toBe(true);
    expect(provider.start).toHaveBeenCalledOnce();
  });

  it('fails closed without an enforcing sandbox and times out active children', async () => {
    await expect(
      runSandboxedAsyncCommand(makeProvider({ enforcing: false }).provider, {
        ...baseInput(),
      }),
    ).rejects.toThrow('requires an enforcing runner sandbox');

    vi.useFakeTimers();
    const { provider, child } = makeProvider();
    child.kill.mockImplementation(() => {
      child.emit('close', null, 'SIGTERM');
      return true;
    });
    const resultPromise = runSandboxedAsyncCommand(provider, {
      ...baseInput(),
      timeoutMs: 10,
    });
    const assertion = expect(resultPromise).rejects.toThrow(
      'Command timed out with signal SIGTERM',
    );

    await vi.advanceTimersByTimeAsync(10);

    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
