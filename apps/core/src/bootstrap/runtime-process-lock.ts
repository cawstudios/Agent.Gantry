import fs from 'fs';
import path from 'path';

export interface RuntimeProcessLock {
  lockPath: string;
  release: () => void;
}

export interface RuntimeProcessLockDeps {
  fs?: Pick<
    typeof fs,
    'existsSync' | 'mkdirSync' | 'readFileSync' | 'rmSync' | 'writeFileSync'
  >;
  now?: () => Date;
  pid?: number;
  argv?: string[];
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => void;
  onExit?: (handler: () => void) => void;
}

interface RuntimeLockFile {
  pid: number;
  startedAt: string;
  command: string;
}

function isLockFile(value: unknown): value is RuntimeLockFile {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.startedAt === 'string' &&
    typeof record.command === 'string'
  );
}

function readLockFile(
  lockPath: string,
  fileSystem: RuntimeProcessLockDeps['fs'],
): RuntimeLockFile | null {
  try {
    const parsed = JSON.parse(fileSystem!.readFileSync(lockPath, 'utf-8'));
    return isLockFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isProcessAlive(
  pid: number,
  kill: NonNullable<RuntimeProcessLockDeps['kill']>,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export function acquireRuntimeProcessLock(
  dataDir: string,
  deps: RuntimeProcessLockDeps = {},
): RuntimeProcessLock {
  const fileSystem = deps.fs || fs;
  const pid = deps.pid || process.pid;
  const argv = deps.argv || process.argv;
  const now = deps.now || (() => new Date());
  const kill = deps.kill || process.kill.bind(process);
  const lockPath = path.join(dataDir, 'myclaw-runtime.lock');

  fileSystem.mkdirSync(dataDir, { recursive: true });

  const writeLock = () => {
    const lockFile: RuntimeLockFile = {
      pid,
      startedAt: now().toISOString(),
      command: argv.join(' '),
    };
    fileSystem.writeFileSync(
      lockPath,
      `${JSON.stringify(lockFile, null, 2)}\n`,
      {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      },
    );
  };

  try {
    writeLock();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;

    const existing = readLockFile(lockPath, fileSystem);
    if (existing && isProcessAlive(existing.pid, kill)) {
      throw new Error(
        `Another MyClaw runtime is already running for this runtime home (pid ${existing.pid}). Stop it before starting a second runtime.`,
      );
    }

    fileSystem.rmSync(lockPath, { force: true });
    writeLock();
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const existing = readLockFile(lockPath, fileSystem);
    if (!existing || existing.pid !== pid) return;
    fileSystem.rmSync(lockPath, { force: true });
  };

  deps.onExit?.(release);

  return { lockPath, release };
}
