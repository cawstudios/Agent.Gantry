import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';
import { getIpcResponseSigningPrivateKey } from './ipc-auth.js';
import type { ParsedBrowserIpcRequest } from './ipc-parsing.js';
import {
  processBrowserIpcRequest,
  writeBrowserIpcResponse,
} from './ipc-browser-handler.js';
import type { IpcDeps } from './ipc-domain-types.js';

interface IpcBrowserRequestLogger {
  warn: (obj: Record<string, unknown>, message: string) => void;
  error: (obj: Record<string, unknown>, message: string) => void;
}

/**
 * Run a parsed browser IPC request through the backend and emit a signed socket
 * response. Filesystem request scanning was removed with the event-only IPC
 * cutover; callers are responsible for socket rate limits and in-flight caps.
 */
export async function runBrowserIpcRequest(input: {
  request: ParsedBrowserIpcRequest;
  sourceAgentFolder: string;
  browserIpcAuthorized: boolean;
  ipcBaseDir: string;
  deps: IpcDeps;
  logger: IpcBrowserRequestLogger;
}): Promise<void> {
  const {
    request,
    sourceAgentFolder,
    browserIpcAuthorized,
    ipcBaseDir,
    deps,
    logger,
  } = input;
  try {
    const response = await processBrowserIpcRequest(request, {
      sourceAgentFolder,
      browserProfileName: resolveConversationBrowserProfile({
        workspaceKey: sourceAgentFolder,
        conversationId: request.chatJid,
      }),
      browserIpcAuthorized,
      getFileArtifactStore: deps.getFileArtifactStore,
      callBrowserTool: deps.callBrowserTool,
      publishBrowserJobActivity: deps.publishBrowserJobActivity,
      closeBrowserToolBackends: deps.closeBrowserToolBackends,
      getBrowserUsageSettings: deps.getBrowserUsageSettings,
      timeoutMs: request.timeoutMs,
      deadlineAtMs: request.deadlineAtMs,
    });
    writeBrowserIpcResponse(
      ipcBaseDir,
      sourceAgentFolder,
      {
        requestId: request.requestId,
        ok: response.ok,
        data: response.data,
        error: response.error,
      },
      getIpcResponseSigningPrivateKey(
        sourceAgentFolder,
        request.threadId,
        request.responseKeyId,
      ),
    );
  } catch (err) {
    logger.error(
      { requestId: request.requestId, sourceAgentFolder, err },
      'Error processing browser IPC request',
    );
    try {
      writeBrowserIpcResponse(
        ipcBaseDir,
        sourceAgentFolder,
        {
          requestId: request.requestId,
          ok: false,
          error: 'Failed to process browser request',
        },
        getIpcResponseSigningPrivateKey(
          sourceAgentFolder,
          request.threadId,
          request.responseKeyId,
        ),
      );
    } catch (writeErr) {
      logger.warn(
        { sourceAgentFolder, requestId: request.requestId, err: writeErr },
        'Failed to emit browser IPC error response',
      );
    }
  }
}

/**
 * Emit the signed "failed to process" browser response over the registered
 * socket responder.
 */
export function writeBrowserFailureResponse(input: {
  ipcBaseDir: string;
  sourceAgentFolder: string;
  requestId: string;
  authThreadId?: string;
  responseKeyId?: string;
  logger: IpcBrowserRequestLogger;
}): void {
  const {
    ipcBaseDir,
    sourceAgentFolder,
    requestId,
    authThreadId,
    responseKeyId,
    logger,
  } = input;
  try {
    writeBrowserIpcResponse(
      ipcBaseDir,
      sourceAgentFolder,
      { requestId, ok: false, error: 'Failed to process browser request' },
      getIpcResponseSigningPrivateKey(
        sourceAgentFolder,
        authThreadId,
        responseKeyId,
      ),
    );
  } catch (writeErr) {
    logger.warn(
      { sourceAgentFolder, requestId, err: writeErr },
      'Failed to emit browser IPC error response',
    );
  }
}
