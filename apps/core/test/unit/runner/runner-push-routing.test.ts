import { afterEach, describe, expect, it, vi } from 'vitest';

// runtime-env.ts (transitively imported by query-loop.ts) reads required path
// env at module-eval time. vi.hoisted runs before the hoisted imports below, so
// the vars are present when query-loop.ts's module graph is first evaluated.
vi.hoisted(() => {
  process.env.GANTRY_WORKSPACE_GROUP_DIR ??= '/tmp/gantry-test-group';
  process.env.GANTRY_WORKSPACE_EXTRA_DIR ??= '/tmp/gantry-test-extra';
  process.env.GANTRY_IPC_DIR ??= '/tmp/gantry-test-ipc';
});

import { routeRunnerPushFrame } from '@core/adapters/llm/anthropic-claude-agent/runner/query-loop.js';
import type { IpcWireFrame } from '@core/shared/ipc-wire.js';
import {
  clearLiveToolRuleCachesForTest,
  readLiveToolRules,
} from '@core/shared/live-tool-rules.js';

function frame(partial: Partial<IpcWireFrame>): IpcWireFrame {
  return {
    v: 1,
    type: 'push',
    channel: 'continuation',
    id: 'f1',
    payload: {},
    ...partial,
  } as IpcWireFrame;
}

describe('routeRunnerPushFrame (socket-authoritative continuation)', () => {
  afterEach(() => {
    clearLiveToolRuleCachesForTest();
  });

  it('routes a continuation push payload directly to the stream handler', () => {
    const onContinuation = vi.fn();
    const onClose = vi.fn();

    const result = routeRunnerPushFrame(
      frame({
        channel: 'continuation',
        payload: { threadId: null, sequence: 1, text: 'from-socket-frame' },
      }),
      { onContinuation, onClose },
    );

    expect(onContinuation).toHaveBeenCalledWith('from-socket-frame');
    expect(onClose).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: false });
  });

  it('routes a close-channel push directly to the close handler', () => {
    const onContinuation = vi.fn();
    const onClose = vi.fn();

    const result = routeRunnerPushFrame(
      frame({ channel: 'close', payload: {} }),
      { onContinuation, onClose },
    );

    expect(onContinuation).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ closed: true });
  });

  it('treats ctrl:drain as an immediate stream close', () => {
    const onContinuation = vi.fn();
    const onClose = vi.fn();

    const result = routeRunnerPushFrame(
      {
        v: 1,
        type: 'ctrl',
        channel: null,
        ctrl: 'drain',
        id: 'drain-1',
        payload: {},
      },
      { onContinuation, onClose },
    );

    expect(onContinuation).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ closed: true });
  });

  it('ignores malformed continuation payloads without closing the stream', () => {
    const onContinuation = vi.fn();
    const onClose = vi.fn();

    const result = routeRunnerPushFrame(
      frame({
        channel: 'continuation',
        payload: { sequence: 1 },
      }),
      { onContinuation, onClose },
    );

    expect(onContinuation).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: false });
  });

  it('updates live tool rule cache without draining the continuation mailbox', () => {
    const onContinuation = vi.fn();
    const onClose = vi.fn();

    const result = routeRunnerPushFrame(
      frame({
        channel: 'live_tool_rules',
        payload: { runHandle: 'run_1', rules: ['FileRead'] },
      }),
      { onContinuation, onClose },
    );

    expect(onContinuation).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: false });
    expect(
      readLiveToolRules({
        ipcDir: '/tmp/nonexistent-live-tool-rules',
        runHandle: 'run_1',
      }),
    ).toEqual(['FileRead']);
  });
});
