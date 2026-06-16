import { randomUUID } from 'crypto';

import type { IpcConnection } from '../shared/ipc-connection.js';

/**
 * Identity of the continuation mailbox a follow-up message (or close signal) is
 * destined for. `groupFolder` + `chatJid` (+ optional `threadId`) address the
 * per-conversation mailbox today; `runHandle` lets the socket carrier resolve
 * the single live runner connection serving that run.
 */
export interface ContinuationTarget {
  groupFolder: string;
  chatJid: string;
  threadId: string | null;
  runHandle: string | null;
}

/**
 * Carrier seam for delivering a continuation follow-up / close to a live agent
 * run. The socket event is the authoritative transport; filesystem mailbox
 * fallback is intentionally not part of the cutover contract.
 */
export interface ContinuationDelivery {
  deliverContinuation: (
    target: ContinuationTarget,
    text: string,
    sequence: number,
  ) => boolean;
  deliverClose: (target: ContinuationTarget) => void;
}

export const unavailableContinuationDelivery: ContinuationDelivery = {
  deliverContinuation() {
    return false;
  },
  deliverClose() {
    // No live socket is available.
  },
};

export function makeSocketContinuationDelivery(
  connectionsForFolder: (folder: string) => IpcConnection[],
): ContinuationDelivery {
  function findRunner(target: ContinuationTarget): IpcConnection | undefined {
    // R2: runHandle is fresh-per-spawn and cleared on run end, so only the
    // current run resolves. The folder match is asserted too (defense in depth).
    if (!target.runHandle) return undefined;
    return connectionsForFolder(target.groupFolder).find(
      (c) =>
        c.scope?.role === 'runner' &&
        c.scope?.runHandle === target.runHandle &&
        c.scope?.sourceAgentFolder === target.groupFolder,
    );
  }
  return {
    deliverContinuation(target, text, sequence) {
      const conn = findRunner(target);
      if (!conn) return false;
      conn.send({
        v: 1,
        type: 'push',
        channel: 'continuation',
        id: randomUUID(),
        payload: { threadId: target.threadId, sequence, text },
      });
      return true;
    },
    deliverClose(target) {
      const conn = findRunner(target);
      if (conn) {
        conn.send({
          v: 1,
          type: 'push',
          channel: 'close',
          id: randomUUID(),
          payload: { threadId: target.threadId },
        });
      }
    },
  };
}
