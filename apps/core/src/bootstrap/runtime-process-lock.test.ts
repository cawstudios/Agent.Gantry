import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireRuntimeProcessLock } from './runtime-process-lock.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-runtime-lock-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('acquireRuntimeProcessLock', () => {
  it('creates and releases a runtime lock file for the current process', () => {
    const dataDir = makeTempDir();

    const lock = acquireRuntimeProcessLock(dataDir, {
      pid: 1234,
      argv: ['node', 'dist/index.js'],
      now: () => new Date('2026-04-24T09:30:00.000Z'),
      kill: vi.fn(),
    });

    expect(lock.lockPath).toBe(path.join(dataDir, 'myclaw-runtime.lock'));
    expect(fs.existsSync(lock.lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock.lockPath, 'utf-8'))).toEqual({
      pid: 1234,
      startedAt: '2026-04-24T09:30:00.000Z',
      command: 'node dist/index.js',
    });

    lock.release();

    expect(fs.existsSync(lock.lockPath)).toBe(false);
  });

  it('rejects a second runtime when an existing lock pid is alive', () => {
    const dataDir = makeTempDir();
    acquireRuntimeProcessLock(dataDir, {
      pid: 1234,
      argv: ['node', 'dist/index.js'],
      kill: vi.fn(),
    });

    expect(() =>
      acquireRuntimeProcessLock(dataDir, {
        pid: 5678,
        argv: ['node', 'dist/index.js'],
        kill: vi.fn(),
      }),
    ).toThrow(/Another MyClaw runtime is already running.*pid 1234/);
  });

  it('replaces a stale runtime lock when the old pid is gone', () => {
    const dataDir = makeTempDir();
    const lockPath = path.join(dataDir, 'myclaw-runtime.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1234,
        startedAt: '2026-04-24T09:00:00.000Z',
        command: 'node dist/index.js',
      }),
      'utf-8',
    );

    const lock = acquireRuntimeProcessLock(dataDir, {
      pid: 5678,
      argv: ['node', 'dist/index.js'],
      now: () => new Date('2026-04-24T09:31:00.000Z'),
      kill: vi.fn(() => {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }),
    });

    expect(JSON.parse(fs.readFileSync(lock.lockPath, 'utf-8'))).toMatchObject({
      pid: 5678,
      startedAt: '2026-04-24T09:31:00.000Z',
    });
  });

  it('cleans up the lock on process exit when registered', () => {
    const dataDir = makeTempDir();
    let exitHandler: (() => void) | undefined;

    const lock = acquireRuntimeProcessLock(dataDir, {
      pid: 1234,
      argv: ['node', 'dist/index.js'],
      kill: vi.fn(),
      onExit: (handler) => {
        exitHandler = handler;
      },
    });

    expect(fs.existsSync(lock.lockPath)).toBe(true);

    exitHandler?.();

    expect(fs.existsSync(lock.lockPath)).toBe(false);
  });
});
