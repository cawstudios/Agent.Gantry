import { describe, expect, it, vi } from 'vitest';

// runtime-env.ts (transitively imported by query-loop.ts) reads required path
// env at module-eval time. vi.hoisted runs before the hoisted imports below, so
// the vars are present when query-loop.ts's module graph is first evaluated.
vi.hoisted(() => {
  process.env.GANTRY_WORKSPACE_GROUP_DIR ??= '/tmp/gantry-test-group';
  process.env.GANTRY_WORKSPACE_EXTRA_DIR ??= '/tmp/gantry-test-extra';
  process.env.GANTRY_IPC_DIR ??= '/tmp/gantry-test-ipc';
  process.env.GANTRY_IPC_INPUT_DIR ??= '/tmp/gantry-test-ipc/input';
});

import { routeRunnerPushFrame } from '@core/adapters/llm/anthropic-claude-agent/runner/query-loop.js';
import type { IpcWireFrame } from '@core/shared/ipc-wire.js';

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

describe('routeRunnerPushFrame', () => {
  it('routes a continuation push to steering accept (== drainIpcInput)', () => {
    const acceptSteering = vi.fn();
    const onClose = vi.fn();

    const result = routeRunnerPushFrame(
      frame({ channel: 'continuation', payload: { text: 'follow up please' } }),
      { acceptSteering, onClose },
    );

    expect(acceptSteering).toHaveBeenCalledTimes(1);
    expect(acceptSteering).toHaveBeenCalledWith('follow up please');
    expect(onClose).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: false });
  });

  it('routes a close-channel push to the close body and reports closed', () => {
    const acceptSteering = vi.fn();
    const onClose = vi.fn();

    const result = routeRunnerPushFrame(
      frame({ channel: 'close', payload: {} }),
      { acceptSteering, onClose },
    );

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(acceptSteering).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: true });
  });

  it('treats a continuation carrying close:true as a close (R4: close wins)', () => {
    const acceptSteering = vi.fn();
    const onClose = vi.fn();

    const result = routeRunnerPushFrame(
      frame({
        channel: 'continuation',
        payload: { text: 'ignored', close: true },
      }),
      { acceptSteering, onClose },
    );

    // Close takes precedence; the text is NOT delivered as steering.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(acceptSteering).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: true });
  });

  it('ignores a continuation push without a string text (no accept, no close)', () => {
    const acceptSteering = vi.fn();
    const onClose = vi.fn();

    const result = routeRunnerPushFrame(
      frame({ channel: 'continuation', payload: { text: 42 } }),
      { acceptSteering, onClose },
    );

    expect(acceptSteering).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: false });
  });

  it('ignores an unrelated push channel', () => {
    const acceptSteering = vi.fn();
    const onClose = vi.fn();

    const result = routeRunnerPushFrame(
      frame({ channel: 'live_tool_rules', payload: { rules: [] } }),
      { acceptSteering, onClose },
    );

    expect(acceptSteering).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: false });
  });
});
