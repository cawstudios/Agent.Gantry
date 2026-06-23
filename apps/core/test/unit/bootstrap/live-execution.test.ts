import { describe, expect, it, vi } from 'vitest';

import { startLiveExecutionServices } from '@core/app/bootstrap/live-execution.js';

describe('startLiveExecutionServices', () => {
  it('uses durable live admission claims instead of route-wide scans', () => {
    const admissionStop = vi.fn();
    const admissionTrigger = vi.fn();
    const startLiveAdmissionWorkLoop = vi.fn(() => ({
      stop: admissionStop,
      trigger: admissionTrigger,
      done: new Promise<void>(() => {}),
    }));
    const registeredLoops: unknown[] = [];
    let subscribedWake: (() => void) | undefined;
    const unsubscribeWake = vi.fn();

    const handle = startLiveExecutionServices({
      app: {
        getConversationRoutes: vi.fn(() => ({})),
        processGroupMessages: vi.fn(),
        getOrRecoverCursor: vi.fn(),
        setAgentCursor: vi.fn(),
        saveState: vi.fn(),
        queue: {
          getPolicy: vi.fn(() => ({ maxMessageRuns: 3, maxRetries: 7 })),
          enqueueMessageCheck: vi.fn(() => true),
        },
      } as any,
      appId: 'default',
      liveTurnAuthority: undefined,
      liveTurnLeaseDeps: {
        liveTurns: {
          claimLiveAdmissionWorkItems: vi.fn(),
          renewLiveAdmissionWorkItemClaim: vi.fn(),
          deferLiveAdmissionWorkItem: vi.fn(),
          settleLiveAdmissionWorkItem: vi.fn(),
        },
        coordination: {},
        workerInstanceId: 'worker-1',
      } as any,
      messageLoopDeps: {} as any,
      recoveryCoordinator: {
        onTransition: vi.fn(),
      },
      isEligibleToRecoverLiveTurn: vi.fn(),
      alertNoEligibleLiveTurnRecoverer: undefined,
      recoverPendingMessages: vi.fn(),
      startLiveAdmissionWorkLoop,
      liveAdmissionWakeupSource: {
        subscribe: vi.fn((listener: () => void) => {
          subscribedWake = listener;
          return unsubscribeWake;
        }),
        close: vi.fn(),
      },
      registerActiveAdmissionLoop: (loop) => {
        registeredLoops.push(loop);
      },
      registerActiveRecoveryLoop: vi.fn(),
      onPollingCrash: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(startLiveAdmissionWorkLoop).toHaveBeenCalledOnce();
    expect(startLiveAdmissionWorkLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        maxRetryCount: 7,
      }),
    );
    expect(registeredLoops).toHaveLength(1);

    subscribedWake?.();
    expect(admissionTrigger).toHaveBeenCalledOnce();

    handle.stopAdmission();
    expect(unsubscribeWake).toHaveBeenCalledOnce();
    expect(admissionStop).toHaveBeenCalledOnce();
    expect(registeredLoops).toHaveLength(2);
    expect(registeredLoops[1]).toBeUndefined();
  });

  it('does not start live admission without durable claims', () => {
    const warn = vi.fn();

    const handle = startLiveExecutionServices({
      app: {
        getConversationRoutes: vi.fn(() => ({})),
        processGroupMessages: vi.fn(),
        getOrRecoverCursor: vi.fn(),
        setAgentCursor: vi.fn(),
        saveState: vi.fn(),
        queue: {
          getPolicy: vi.fn(() => ({ maxMessageRuns: 3, maxRetries: 7 })),
          enqueueMessageCheck: vi.fn(() => true),
        },
      } as any,
      appId: 'default',
      liveTurnAuthority: undefined,
      liveTurnLeaseDeps: undefined,
      messageLoopDeps: {} as any,
      recoveryCoordinator: undefined,
      isEligibleToRecoverLiveTurn: vi.fn(),
      alertNoEligibleLiveTurnRecoverer: undefined,
      recoverPendingMessages: vi.fn(),
      registerActiveAdmissionLoop: vi.fn(),
      registerActiveRecoveryLoop: vi.fn(),
      onPollingCrash: vi.fn(),
      info: vi.fn(),
      warn,
    });

    expect(handle.admissionLoop).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { processRole: undefined },
      'Live admission requires durable admission claims; live admission disabled for this role',
    );
  });
});
