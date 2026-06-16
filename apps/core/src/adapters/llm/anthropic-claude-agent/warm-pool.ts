import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import {
  writeBoundIdentityFile,
  writeBoundIdentityFilePath,
  type BoundIdentity,
} from '../../../runner/mcp/bound-identity.js';
import type {
  BoundRun,
  ConversationBindScope,
  SharedBootRecipe,
  WarmBindDelivery,
  WarmWorkerHandle,
} from '../../../application/agent-execution/warm-pool-capable.js';

const READY_MARKER = 'awaiting bind';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const CACHE_PROBE_ENV = 'GANTRY_WARM_POOL_CACHE_PROBE';

type SpawnFunction = typeof nodeSpawn;

interface WarmWorkerRecord {
  readonly handle: WarmWorkerHandle;
  readonly process: ChildProcess;
  readonly cleanup?: () => Promise<void> | void;
}

function boundIdentityFromScope(scope: ConversationBindScope): BoundIdentity {
  return {
    chatJid: scope.chatJid,
    ...(scope.threadId ? { threadId: scope.threadId } : {}),
    ...(scope.memoryUserId ? { memoryUserId: scope.memoryUserId } : {}),
    runHandle: scope.runHandle,
    ipcAuthToken: scope.ipcAuthToken,
    ...(scope.browserIpcAuthToken
      ? { browserIpcAuthToken: scope.browserIpcAuthToken }
      : {}),
    memoryIpcAuthToken: scope.memoryIpcAuthToken,
    ipcResponseKeyId: scope.ipcResponseKeyId,
    ipcResponseVerifyKey: scope.ipcResponseVerifyKey,
  };
}

export interface AnthropicWarmPoolOptions {
  spawn?: SpawnFunction;
  cachePrewarmProbe?: (handle: WarmWorkerHandle) => Promise<void>;
  now?: () => number;
  readyTimeoutMs?: number;
}

export class AnthropicWarmPoolController {
  private readonly spawn: SpawnFunction;
  private readonly cachePrewarmProbe?: (
    handle: WarmWorkerHandle,
  ) => Promise<void>;
  private readonly now: () => number;
  private readonly readyTimeoutMs: number;
  private readonly workers = new Map<string, WarmWorkerRecord>();
  private socketBindDelivery: WarmBindDelivery | undefined;

  constructor(options: AnthropicWarmPoolOptions = {}) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.cachePrewarmProbe = options.cachePrewarmProbe;
    this.now = options.now ?? Date.now;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  async prewarm(recipe: SharedBootRecipe): Promise<WarmWorkerHandle> {
    const command = recipe.runnerCommand;
    const runnerArgs = recipe.runnerArgs;
    const runnerInput = recipe.runnerInput;
    if (!command || !runnerArgs || !runnerInput) {
      throw new Error(
        'Anthropic warm prewarm requires runnerCommand, runnerArgs, and runnerInput',
      );
    }

    const processName =
      recipe.runnerProcessName ??
      `gantry-warm-pool-${this.now()}-${randomUUID().slice(0, 8)}`;
    const args = [...runnerArgs, `--gantry-warm-pool-worker=${processName}`];
    const env: NodeJS.ProcessEnv = {
      ...recipe.runnerEnv,
      GANTRY_AGENT_RUN_HANDLE: processName,
      GANTRY_WARM_POOL_BOOT: 'generic',
      GANTRY_WARM_POOL_MARKER: 'gantry-warm-pool-worker',
      GANTRY_WARM_POOL_WORKER: '1',
    };
    const process = this.spawn(command, args, {
      cwd: recipe.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const handle: WarmWorkerHandle = {
      id: processName,
      key: recipe.key,
      bornAt: this.now(),
      processName,
      ...(env.GANTRY_IPC_DIR ? { ipcDir: env.GANTRY_IPC_DIR } : {}),
      ...(env.GANTRY_BOUND_IDENTITY_FILE
        ? { boundIdentityFile: env.GANTRY_BOUND_IDENTITY_FILE }
        : {}),
      ...(env.GANTRY_MEMORY_IPC_AUTH_TOKEN
        ? { memoryIpcAuthToken: env.GANTRY_MEMORY_IPC_AUTH_TOKEN }
        : {}),
      bound: false,
    };
    this.workers.set(handle.id, { handle, process, cleanup: recipe.cleanup });
    const ready = this.waitForReady(handle, process);
    try {
      process.stdin?.write(
        JSON.stringify({
          ...runnerInput,
          prompt: '',
          compiledSystemPrompt: recipe.compiledSystemPrompt,
          warmGenericBoot: true,
        }),
      );
      process.stdin?.end();
      await ready;
      return handle;
    } catch (err) {
      this.workers.delete(handle.id);
      this.terminate(process);
      await recipe.cleanup?.();
      throw err;
    }
  }

  async bind(
    handle: WarmWorkerHandle,
    scope: ConversationBindScope,
  ): Promise<BoundRun> {
    const worker = this.workers.get(handle.id);
    if (!worker) {
      throw new Error(`Warm worker ${handle.id} not found`);
    }
    if (handle.bound) {
      throw new Error(`Warm worker ${handle.id} is already bound`);
    }
    this.writeBoundIdentity(scope);
    const socketDelivered =
      (await this.socketBindDelivery
        ?.deliver(handle, scope)
        .catch(() => false)) ?? false;
    if (!socketDelivered) {
      throw new Error(
        `Warm worker ${handle.id} has no connected socket bind delivery`,
      );
    }
    handle.bound = true;
    return {
      handle,
      process: worker.process,
      runHandle: scope.runHandle,
    };
  }

  async recycle(handle: WarmWorkerHandle): Promise<void> {
    const worker = this.workers.get(handle.id);
    this.workers.delete(handle.id);
    if (!worker) return;
    try {
      this.terminate(worker.process);
    } finally {
      await worker.cleanup?.();
    }
  }

  async prewarmCaches(handle: WarmWorkerHandle): Promise<void> {
    if (process.env[CACHE_PROBE_ENV] !== '1') return;
    await this.cachePrewarmProbe?.(handle);
  }

  async healthCheck(handle: WarmWorkerHandle): Promise<boolean> {
    const worker = this.workers.get(handle.id);
    return Boolean(
      worker && worker.process.exitCode === null && !worker.process.killed,
    );
  }

  setWarmBindDelivery(delivery: WarmBindDelivery): void {
    this.socketBindDelivery = delivery;
  }

  private writeBoundIdentity(scope: ConversationBindScope): void {
    const identity = boundIdentityFromScope(scope);
    if (scope.boundIdentityFile) {
      writeBoundIdentityFilePath(scope.boundIdentityFile, identity);
      return;
    }
    writeBoundIdentityFile(scope.ipcDir, identity);
  }

  private waitForReady(
    handle: WarmWorkerHandle,
    process: ChildProcess,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderrTail = '';
      const appendStderr = (chunk: Buffer | string): string => {
        stderrTail = `${stderrTail}${String(chunk)}`;
        if (stderrTail.length > 4_000) {
          stderrTail = stderrTail.slice(-4_000);
        }
        return stderrTail;
      };
      const stderrSuffix = (): string => {
        const trimmed = stderrTail.trim();
        return trimmed ? `; stderr tail: ${trimmed}` : '';
      };
      const cleanup = () => {
        clearTimeout(timer);
        process.stderr?.off('data', onStderr);
        process.off('exit', onExit);
        process.off('error', onError);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          this.workers.delete(handle.id);
          reject(error);
          return;
        }
        resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `Timed out waiting ${this.readyTimeoutMs}ms for warm worker ${handle.id} to become bind-ready${stderrSuffix()}`,
            ),
          ),
        this.readyTimeoutMs,
      );
      const onStderr = (chunk: Buffer | string) => {
        if (appendStderr(chunk).includes(READY_MARKER)) finish();
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(
          new Error(
            `Warm worker ${handle.id} exited before bind-ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})${stderrSuffix()}`,
          ),
        );
      };
      const onError = (error: Error) => {
        finish(error);
      };
      process.stderr?.on('data', onStderr);
      process.once('exit', onExit);
      process.once('error', onError);
    });
  }

  private terminate(process: ChildProcess): void {
    if (typeof process.pid === 'number') {
      try {
        globalThis.process.kill(-process.pid, 'SIGTERM');
        return;
      } catch {
        /* fall through to direct child termination */
      }
    }
    process.kill('SIGTERM');
  }
}
