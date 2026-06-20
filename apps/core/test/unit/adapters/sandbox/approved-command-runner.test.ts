import { describe, expect, it } from 'vitest';

import { runApprovedSandboxCommand } from '@core/adapters/sandbox/approved-command-runner.js';

describe('runApprovedSandboxCommand', () => {
  it('runs an explicit argv with the provided cwd and environment', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          "if (process.env.GANTRY_TEST_VALUE !== 'ok') process.exit(2)",
        ],
        cwd: process.cwd(),
        env: { ...process.env, GANTRY_TEST_VALUE: 'ok' },
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ stdout: '', stderr: '' });
  });

  it('redacts stderr when the approved command fails', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          "console.error('ACCESS_TOKEN=secret-value'); process.exit(3)",
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
        redactOutput: (value) =>
          value.replace(/ACCESS_TOKEN=[^\s]+/g, '<redacted>'),
      }),
    ).rejects.toThrow(/<redacted>/);
  });

  it('drains stdout so verbose approved commands cannot block on a pipe', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          "process.stdout.write('x'.repeat(1024 * 1024 * 2))",
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ stderr: '' });
  });

  it('returns bounded stdout for successful approved commands', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [process.execPath, '-e', "console.log('done')"],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
        stdoutMaxBytes: 100,
      }),
    ).resolves.toMatchObject({ stdout: 'done' });
  });

  it('aborts a running command through AbortSignal', async () => {
    const controller = new AbortController();
    const run = runApprovedSandboxCommand({
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 30_000)'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    controller.abort();

    await expect(run).rejects.toThrow('Command aborted.');
  });

  it('rejects before spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runApprovedSandboxCommand({
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 30_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow('Command aborted.');
  });

  it('rejects timed-out commands even when SIGTERM exits cleanly', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 30_000)",
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('Command timed out');
  });
});
