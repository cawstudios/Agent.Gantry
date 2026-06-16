import type {
  ConversationBindScope,
  WarmBindDelivery,
  WarmWorkerHandle,
} from '../application/agent-execution/warm-pool-capable.js';
import type { IpcConnection } from '../shared/ipc-connection.js';

function bindPayload(scope: ConversationBindScope): Record<string, unknown> {
  return {
    chatJid: scope.chatJid,
    firstMessage: scope.firstMessage,
    ...(scope.memoryBlock ? { memoryBlock: scope.memoryBlock } : {}),
    ...(scope.guardrailPreface
      ? { guardrailPreface: scope.guardrailPreface }
      : {}),
    runHandle: scope.runHandle,
    ...(scope.threadId ? { threadId: scope.threadId } : {}),
    ...(scope.memoryUserId ? { memoryUserId: scope.memoryUserId } : {}),
    ipcAuthToken: scope.ipcAuthToken,
    ...(scope.browserIpcAuthToken
      ? { browserIpcAuthToken: scope.browserIpcAuthToken }
      : {}),
    memoryIpcAuthToken: scope.memoryIpcAuthToken,
    ipcResponseKeyId: scope.ipcResponseKeyId,
    ipcResponseVerifyKey: scope.ipcResponseVerifyKey,
  };
}

export function makeSocketWarmBindDelivery(
  connectionsForFolder: (folder: string) => IpcConnection[],
): WarmBindDelivery {
  return {
    async deliver(
      handle: WarmWorkerHandle,
      scope: ConversationBindScope,
    ): Promise<boolean> {
      const workerRunHandle = handle.processName ?? handle.id;
      const runner = connectionsForFolder(scope.groupFolder).find(
        (candidate) =>
          candidate.scope?.role === 'runner' &&
          candidate.scope?.runHandle === workerRunHandle,
      );
      if (!runner) return false;
      runner.send({
        v: 1,
        type: 'push',
        channel: 'bind',
        id: `bind:${scope.runHandle}`,
        payload: bindPayload(scope),
      });
      return true;
    },
  };
}
