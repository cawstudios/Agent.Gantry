import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicClaudeAgentExecutionAdapter } from '@core/adapters/llm/anthropic-claude-agent/execution-adapter.js';
import {
  AnthropicWarmPoolController,
  IpcDirectoryBindTransport,
} from '@core/adapters/llm/anthropic-claude-agent/warm-pool.js';
import {
  hasWarmPoolCapability,
  poolKeyOf,
  type ConversationBindScope,
  type SharedBootRecipe,
} from '@core/application/agent-execution/warm-pool-capable.js';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-warm-pool-'));
  tempRoots.push(root);
  return root;
}

function makeRecipe(): SharedBootRecipe {
  const keyInput = {
    providerId: 'anthropic:claude-agent-sdk',
    appId: 'app-1',
    agentId: 'agent-1',
    persona: 'sales',
    model: 'opus',
    toolSurface: { gantryMcp: ['send_message'], native: ['Read'] },
    mcpSet: ['mcp:shopify-api'],
    thinking: { mode: 'enabled', effort: 'medium' },
    systemPromptVersion: 'prompt-v1',
  } as const;
  return {
    ...keyInput,
    key: poolKeyOf(keyInput),
    cwd: '/tmp/agent',
    compiledSystemPrompt: 'shared prompt',
    runnerCommand: '/usr/local/bin/node',
    runnerArgs: ['/opt/gantry/runner/index.js'],
    runnerEnv: {
      GANTRY_IPC_DIR: '/tmp/gantry/ipc/agent-1',
      GANTRY_IPC_INPUT_DIR: '/tmp/gantry/ipc/agent-1/input/generic',
    },
    runnerInput: {
      groupFolder: 'agent-1',
      chatJid: 'warm:generic',
      prompt: 'must be replaced by generic boot',
    },
    runnerProcessName: 'warm-worker-1',
  };
}

function makeScope(root = makeTempRoot()): ConversationBindScope {
  return {
    appId: 'app-1',
    agentId: 'agent-1',
    chatJid: 'wa:111',
    threadId: 'thread-1',
    memoryUserId: 'user-1',
    memoryBlock: 'MEM-111',
    firstMessage: 'do you have kaju katli?',
    guardrailPreface: 'Stay on catalog.',
    runHandle: 'run-bound-1',
    ipcDir: path.join(root, 'ipc'),
    ipcInputDir: path.join(root, 'ipc', 'input', 'conv-wa-111'),
    memoryIpcAuthToken: 'memory-token',
  };
}

function makeChild(): ChildProcess & {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as ChildProcess & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  child.killed = false;
  return child;
}

async function prewarmReady(
  controller: AnthropicWarmPoolController,
  recipe: SharedBootRecipe,
  child: ReturnType<typeof makeChild>,
) {
  const prewarm = controller.prewarm(recipe);
  await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(1));
  child.stderr.emit(
    'data',
    Buffer.from(
      '[agent-runner] Warm worker booted generic via startup(); awaiting bind\n',
    ),
  );
  return prewarm;
}

describe('Anthropic warm pool adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes the optional WarmPoolCapable verbs on the Anthropic adapter', () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    expect(hasWarmPoolCapability(adapter)).toBe(true);
  });

  it('prewarms a generic runner process and waits for the bind-ready marker', async () => {
    const child = makeChild();
    const spawn = vi.fn(() => child);
    const controller = new AnthropicWarmPoolController({
      spawn,
      now: () => 1_000,
      readyTimeoutMs: 500,
    });
    const recipe = makeRecipe();

    const handle = await prewarmReady(controller, recipe, child);

    expect(spawn).toHaveBeenCalledWith(
      '/usr/local/bin/node',
      [
        '/opt/gantry/runner/index.js',
        '--gantry-warm-pool-worker=warm-worker-1',
      ],
      expect.objectContaining({
        cwd: '/tmp/agent',
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({
          GANTRY_AGENT_RUN_HANDLE: 'warm-worker-1',
          GANTRY_WARM_POOL_BOOT: 'generic',
          GANTRY_WARM_POOL_WORKER: '1',
        }),
      }),
    );
    const stdinInput = JSON.parse(String(child.stdin.write.mock.calls[0][0]));
    expect(stdinInput).toEqual(
      expect.objectContaining({
        chatJid: 'warm:generic',
        compiledSystemPrompt: 'shared prompt',
        prompt: '',
        warmGenericBoot: true,
      }),
    );
    expect(handle).toEqual(
      expect.objectContaining({
        id: 'warm-worker-1',
        key: recipe.key,
        bornAt: 1_000,
        bound: false,
        processName: 'warm-worker-1',
      }),
    );
  });

  it('binds once by writing the shim bind and bound-identity envelopes', async () => {
    const child = makeChild();
    const controller = new AnthropicWarmPoolController({
      spawn: vi.fn(() => child),
      bindTransport: new IpcDirectoryBindTransport(),
      now: () => 1_000,
    });
    const handle = await prewarmReady(controller, makeRecipe(), child);
    const scope = makeScope();

    const bound = await controller.bind(handle, scope);

    expect(bound).toEqual({
      handle,
      process: child,
      runHandle: 'run-bound-1',
    });
    expect(handle.bound).toBe(true);
    const bindEnvelope = JSON.parse(
      fs.readFileSync(path.join(scope.ipcInputDir, '_bind.json'), 'utf-8'),
    );
    expect(bindEnvelope).toEqual({
      type: 'bind',
      scope: {
        chatJid: 'wa:111',
        firstMessage: 'do you have kaju katli?',
        guardrailPreface: 'Stay on catalog.',
        memoryBlock: 'MEM-111',
        memoryUserId: 'user-1',
        threadId: 'thread-1',
      },
    });
    const boundIdentity = JSON.parse(
      fs.readFileSync(path.join(scope.ipcDir, 'bound-identity.json'), 'utf-8'),
    );
    expect(boundIdentity).toEqual({
      chatJid: 'wa:111',
      memoryUserId: 'user-1',
      threadId: 'thread-1',
    });

    await expect(controller.bind(handle, scope)).rejects.toThrow(
      'already bound',
    );
  });

  it('recycles a warm worker by terminating the child process and removing the handle', async () => {
    const child = makeChild();
    const controller = new AnthropicWarmPoolController({
      spawn: vi.fn(() => child),
      now: () => 1_000,
    });
    const handle = await prewarmReady(controller, makeRecipe(), child);

    await controller.recycle(handle);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(controller.bind(handle, makeScope())).rejects.toThrow(
      'not found',
    );
  });
});
