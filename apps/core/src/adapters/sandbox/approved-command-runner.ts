import { spawn } from 'node:child_process';

export interface ApprovedCommandRunInput {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
  redactOutput?: (value: string) => string;
}

export interface ApprovedCommandRunResult {
  stdout: string;
  stderr: string;
}

export function runApprovedSandboxCommand(
  input: ApprovedCommandRunInput,
): Promise<ApprovedCommandRunResult> {
  const [command, ...args] = input.argv;
  if (!command) throw new Error('Command is empty.');
  if (input.signal?.aborted) {
    return Promise.reject(new Error('Command aborted.'));
  }
  const stdoutMaxBytes = input.stdoutMaxBytes ?? 4000;
  const stderrMaxBytes = input.stderrMaxBytes ?? 4000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const terminate = () => {
      killProcessGroup(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        killProcessGroup(child, 'SIGKILL');
      }, 1_000);
      forceKillTimer.unref?.();
    };
    const onAbort = () => {
      terminate();
    };
    if (input.signal) {
      if (input.signal.aborted) terminate();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-stdoutMaxBytes);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-stderrMaxBytes);
    });
    child.on('error', (err) => {
      settle(() => reject(err));
    });
    child.on('close', (code, signal) => {
      if (input.signal?.aborted) {
        settle(() => reject(new Error('Command aborted.')));
        return;
      }
      if (timedOut) {
        settle(() =>
          reject(
            new Error(
              `Command timed out${signal ? ` with signal ${signal}` : ''}.`,
            ),
          ),
        );
        return;
      }
      if (code === null && signal) {
        settle(() =>
          reject(new Error(`Command timed out with signal ${signal}.`)),
        );
        return;
      }
      if (code === 0) {
        settle(() =>
          resolve({
            stdout: input.redactOutput
              ? input.redactOutput(stdout.trim())
              : stdout.trim(),
            stderr: input.redactOutput
              ? input.redactOutput(stderr.trim())
              : stderr.trim(),
          }),
        );
        return;
      }
      const redacted = input.redactOutput
        ? input.redactOutput(stderr.trim())
        : stderr.trim();
      settle(() =>
        reject(
          new Error(
            `Command failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}${redacted ? `: ${redacted}` : ''}`,
          ),
        ),
      );
    });
  });
}

function killProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (err) {
      const code =
        err instanceof Error ? (err as NodeJS.ErrnoException).code : '';
      if (code === 'ESRCH') return;
    }
  }
  child.kill(signal);
}
