import fs from 'fs';
import path from 'path';

import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';
import {
  archiveIpcErrorFile,
  claimIpcFile,
  isPendingIpcJsonFile,
  isTrustedDirectory,
} from './ipc-filesystem.js';
import {
  getIpcResponseSigningPrivateKey,
  isBrowserIpcAuthorized,
} from './ipc-auth.js';
import { parseBrowserIpcRequest } from './ipc-parsing.js';
import type { ParsedBrowserIpcRequest } from './ipc-parsing.js';
import {
  processBrowserIpcRequest,
  writeBrowserIpcResponse,
} from './ipc-browser-handler.js';
import type { IpcDeps } from './ipc-domain-types.js';
import { canProcessIpcFile } from './ipc-rate-limit.js';
import {
  releaseBrowserInFlight,
  tryAcquireBrowserInFlight,
} from './ipc-browser-inflight.js';

interface IpcBrowserRequestLogger {
  warn: (obj: Record<string, unknown>, message: string) => void;
  error: (obj: Record<string, unknown>, message: string) => void;
}

export function processBrowserRequestDirectory(input: {
  ipcBaseDir: string;
  sourceAgentFolder: string;
  browserRequestsDir: string;
  deps: IpcDeps;
  logger: IpcBrowserRequestLogger;
}): void {
  const { ipcBaseDir, sourceAgentFolder, browserRequestsDir, deps, logger } =
    input;
  try {
    if (isTrustedDirectory(browserRequestsDir)) {
      const browserFiles = fs
        .readdirSync(browserRequestsDir)
        .filter(isPendingIpcJsonFile);
      for (const file of browserFiles) {
        processOneBrowserRequest({
          ipcBaseDir,
          sourceAgentFolder,
          browserRequestsDir,
          file,
          deps,
          logger,
        });
      }
    } else if (fs.existsSync(browserRequestsDir)) {
      logger.warn(
        { sourceAgentFolder, browserRequestsDir },
        'Ignoring untrusted browser IPC requests directory',
      );
    }
  } catch (err) {
    logger.error(
      { err, sourceAgentFolder },
      'Error reading browser IPC requests directory',
    );
  }
}

/**
 * Run a parsed browser IPC request through the backend and the (router-aware)
 * response writer. Shared by the fs watcher (which passes `file`/`claimedPath`
 * so the on-disk request can be unlinked / archived) and the socket dispatcher
 * (which passes neither — there is no backing file). The fs cleanup is therefore
 * guarded with `if (claimedPath)` / `if (file)` so the socket path is a no-op
 * there, while the watcher path stays byte-identical.
 *
 * The caller is responsible for the shared browser in-flight accounting and the
 * rate-limit gate (the fs and socket carriers mirror each other below).
 */
export async function runBrowserIpcRequest(input: {
  request: ParsedBrowserIpcRequest;
  sourceAgentFolder: string;
  browserIpcAuthorized: boolean;
  ipcBaseDir: string;
  deps: IpcDeps;
  logger: IpcBrowserRequestLogger;
  file?: string;
  claimedPath?: string;
}): Promise<void> {
  const {
    request,
    sourceAgentFolder,
    browserIpcAuthorized,
    ipcBaseDir,
    deps,
    logger,
    file,
    claimedPath,
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
    if (claimedPath) fs.unlinkSync(claimedPath);
  } catch (err) {
    logger.error(
      { file, sourceAgentFolder, err },
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
        'Failed to write browser IPC error fallback',
      );
    }
    if (file && claimedPath) {
      archiveIpcErrorFile(ipcBaseDir, sourceAgentFolder, file, claimedPath);
    }
  }
}

function processOneBrowserRequest(input: {
  ipcBaseDir: string;
  sourceAgentFolder: string;
  browserRequestsDir: string;
  file: string;
  deps: IpcDeps;
  logger: IpcBrowserRequestLogger;
}): void {
  const {
    ipcBaseDir,
    sourceAgentFolder,
    browserRequestsDir,
    file,
    deps,
    logger,
  } = input;
  const filePath = path.join(browserRequestsDir, file);
  let claimedPath = filePath;
  let requestId: string | undefined;
  let authThreadId: string | undefined;
  let responseKeyId: string | undefined;
  try {
    claimedPath = claimIpcFile(filePath);
    const rawRequest = JSON.parse(fs.readFileSync(claimedPath, 'utf-8'));
    const request = parseBrowserIpcRequest(rawRequest, sourceAgentFolder);
    requestId = request.requestId;
    authThreadId = request.threadId;
    responseKeyId = request.responseKeyId;
    const browserIpcAuthorized = isBrowserIpcAuthorized({
      workspaceKey: sourceAgentFolder,
      chatJid: request.chatJid,
      threadId: authThreadId,
    });
    if (
      browserIpcAuthorized &&
      !canProcessIpcFile(sourceAgentFolder, 'browser')
    ) {
      throw new Error('Browser IPC rate limit exceeded');
    }
    if (!tryAcquireBrowserInFlight()) {
      throw new Error('Browser IPC concurrency limit exceeded');
    }
    void runBrowserIpcRequest({
      request,
      sourceAgentFolder,
      browserIpcAuthorized,
      ipcBaseDir,
      deps,
      logger,
      file,
      claimedPath,
    }).finally(() => {
      releaseBrowserInFlight();
    });
  } catch (err) {
    if (requestId) {
      writeBrowserFailureResponse({
        ipcBaseDir,
        sourceAgentFolder,
        requestId,
        authThreadId,
        responseKeyId,
        logger,
      });
    }
    logger.error(
      { file, sourceAgentFolder, err },
      'Error processing browser IPC request',
    );
    archiveIpcErrorFile(ipcBaseDir, sourceAgentFolder, file, claimedPath);
  }
}

/**
 * Emit the signed "failed to process" browser response (routed to a registered
 * responder when one exists, else written as a file). Exported so the socket
 * dispatcher can mirror the fs watcher's cap-exceeded path exactly: a request
 * that hits the shared in-flight cap settles the grandchild with the same signed
 * `{ ok:false }` response it would receive on fs.
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
      'Failed to write browser IPC error fallback',
    );
  }
}
