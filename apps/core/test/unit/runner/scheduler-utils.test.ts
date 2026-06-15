import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSchedulerShortcut } from '@core/runner/mcp/scheduler-utils.js';
import {
  resetBoundIdentitySource,
  setBoundIdentitySource,
} from '@core/runner/mcp/bound-identity.js';

// Pillar 2 / F4: scheduler `this_thread` / `this_topic` / `here` shortcuts must
// resolve the BOUND customer thread (read per call) on a warm worker — not the
// spawn-env `GANTRY_THREAD_ID` const, which on a generic-booted worker is blank
// and would mis-route the scheduled job to the generic/no-thread scope.
describe('resolveSchedulerShortcut bound-thread routing (F4)', () => {
  const previousThreadId = process.env.GANTRY_THREAD_ID;

  beforeEach(() => {
    resetBoundIdentitySource();
  });

  afterEach(() => {
    resetBoundIdentitySource();
    if (previousThreadId === undefined) {
      delete process.env.GANTRY_THREAD_ID;
    } else {
      process.env.GANTRY_THREAD_ID = previousThreadId;
    }
  });

  it('resolves this_thread to the BOUND thread (not the spawn-env thread)', () => {
    // Generic-booted worker: no env thread, but a customer is bound at runtime.
    delete process.env.GANTRY_THREAD_ID;
    setBoundIdentitySource({
      read: () => ({ chatJid: 'wa:x', threadId: 'bound-thread' }),
    });

    expect(resolveSchedulerShortcut('this_thread')).toEqual({
      threadId: 'bound-thread',
    });
    expect(resolveSchedulerShortcut('this_topic')).toEqual({
      threadId: 'bound-thread',
    });
    expect(resolveSchedulerShortcut('here')).toEqual({
      threadId: 'bound-thread',
    });
  });

  it('prefers the bound thread over a stale spawn-env thread', () => {
    // Even if the spawn env still holds a (recycled/stale) thread, the bound
    // identity wins so a recycled worker routes to its current customer.
    process.env.GANTRY_THREAD_ID = 'env-thread';
    setBoundIdentitySource({
      read: () => ({ chatJid: 'wa:x', threadId: 'bound-thread' }),
    });

    expect(resolveSchedulerShortcut('this_thread')).toEqual({
      threadId: 'bound-thread',
    });
    expect(resolveSchedulerShortcut('here')).toEqual({
      threadId: 'bound-thread',
    });
  });

  it('cold fallback: no bound source → resolves the spawn-env thread', () => {
    process.env.GANTRY_THREAD_ID = 'env-thread';
    // No setBoundIdentitySource → falls back to env (cold path, byte-identical).

    expect(resolveSchedulerShortcut('this_thread')).toEqual({
      threadId: 'env-thread',
    });
    expect(resolveSchedulerShortcut('here')).toEqual({
      threadId: 'env-thread',
    });
  });

  it('cold fallback with no thread at all → this_thread errors, here is null', () => {
    delete process.env.GANTRY_THREAD_ID;

    const thisThread = resolveSchedulerShortcut('this_thread');
    expect(thisThread.threadId).toBeNull();
    expect(thisThread.error).toMatch(/can only be used when/i);

    expect(resolveSchedulerShortcut('here')).toEqual({ threadId: null });
  });

  it('me_dm always resolves to a null thread (unchanged)', () => {
    process.env.GANTRY_THREAD_ID = 'env-thread';
    setBoundIdentitySource({
      read: () => ({ chatJid: 'wa:x', threadId: 'bound-thread' }),
    });

    expect(resolveSchedulerShortcut('me_dm')).toEqual({ threadId: null });
  });
});
