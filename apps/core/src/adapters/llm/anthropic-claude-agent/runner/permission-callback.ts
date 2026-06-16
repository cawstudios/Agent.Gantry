import { randomUUID } from 'crypto';
import { nowIso } from '../../../../shared/time/datetime.js';
import { isPlainObject } from '../../../../shared/object.js';
import { persistentPermissionUpdates } from '../../../../shared/permission-tool-rules.js';
import { stableSha256Json } from '../../../../shared/stable-hash.js';
// Warm-pool (F4): the approval-target fallback must be the BOUND customer jid
// (bind-delivered), not the generic boot env, so a pooled worker's permission
// prompts route to its customer. Cold path: returns the env constant.
import { getBoundRuntimeScope } from '../../../../runner/mcp/bound-identity.js';
import { hasValidIpcResponseSignature } from './ipc-signing.js';
import { createSignedIpcRequestEnvelope } from './ipc-signing.js';
import { getActiveRunnerSocketClient } from './active-runner-socket.js';
import type { SemanticCapabilityDefinition } from '../../../../shared/semantic-capabilities.js';
import {
  IPC_AUTH_TOKEN,
  AGENT_ID,
  APP_ID,
  JOB_ID,
  JOB_NAME,
  JOB_RUN_ID,
  IPC_RESPONSE_KEY_ID,
  PERMISSION_REQUEST_TIMEOUT_MS,
} from './runtime-env.js';
import type { PermissionDecision } from './types.js';

const DEFAULT_RUNNER_APP_ID = 'default';
const AGENT_FOLDER_OPTION_KEY = `group${'Folder'}` as const;

const inFlightTimedGrantRequests = new Map<
  string,
  Promise<PermissionDecision>
>();

function timedGrantBatchKey(input: {
  appId: string;
  agentId?: string;
  targetJid?: string;
  agentFolder: string;
  requestFingerprint: string;
}): string {
  // Topic/thread ids route the prompt; approval authority is the parent chat.
  return JSON.stringify([
    input.appId,
    input.agentId ?? '',
    input.targetJid ?? '',
    input.agentFolder,
    JOB_ID,
    JOB_RUN_ID,
    input.requestFingerprint,
  ]);
}

function permissionRequestFingerprint(options: {
  toolName: string;
  toolInput?: unknown;
  blockedPath?: string;
  closestRule?: unknown;
  suggestions?: unknown[];
  decisionOptions?: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): string {
  return stableSha256Json({
    toolName: options.toolName,
    ...(isPlainObject(options.toolInput)
      ? { toolInput: options.toolInput }
      : {}),
    ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
    ...(options.closestRule ? { closestRule: options.closestRule } : {}),
    ...(options.suggestions ? { suggestions: options.suggestions } : {}),
    ...(options.decisionOptions
      ? { decisionOptions: options.decisionOptions }
      : {}),
    ...(options.semanticCapabilityDefinitions
      ? { semanticCapabilityDefinitions: options.semanticCapabilityDefinitions }
      : {}),
  });
}

function canSharePermissionDecision(decision: PermissionDecision): boolean {
  return decision.mode === 'allow_timed_grant';
}

/**
 * Map an already-parsed permission response object (`raw`, the signed payload as
 * written by writePermissionIpcResponse) to a sanitized PermissionDecision.
 *
 * This is the SINGLE source of truth for socket responses. It reconstructs the exact
 * signed field-set/order, re-checks the requestId + responseNonce binding, and
 * verifies the ed25519 signature — so a socket response is validated
 * byte-for-byte identically to a file response. Returns a denial decision on any
 * malformation / nonce mismatch / signature failure.
 */
function decisionFromVerifiedPermissionResponse(
  raw: unknown,
  requestId: string,
  responseNonce: string,
): PermissionDecision {
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as { requestId?: string }).requestId !== requestId
  ) {
    return { approved: false, reason: 'Malformed permission response' };
  }
  const responsePayload: Record<string, unknown> = {
    requestId,
    responseNonce,
    approved: Boolean((raw as { approved?: unknown }).approved),
    ...(typeof (raw as { mode?: unknown }).mode === 'string'
      ? { mode: (raw as { mode: string }).mode }
      : {}),
    ...(typeof (raw as { decidedBy?: unknown }).decidedBy === 'string'
      ? { decidedBy: (raw as { decidedBy: string }).decidedBy }
      : {}),
    ...(typeof (raw as { reason?: unknown }).reason === 'string'
      ? { reason: (raw as { reason: string }).reason }
      : {}),
    ...(Array.isArray(
      (raw as { updatedPermissions?: unknown }).updatedPermissions,
    )
      ? {
          updatedPermissions: (raw as { updatedPermissions: unknown[] })
            .updatedPermissions,
        }
      : {}),
    ...(typeof (raw as { decisionClassification?: unknown })
      .decisionClassification === 'string'
      ? {
          decisionClassification: (raw as { decisionClassification: string })
            .decisionClassification,
        }
      : {}),
    ...(typeof (raw as { timedGrantExpiresAtMs?: unknown })
      .timedGrantExpiresAtMs === 'number'
      ? {
          timedGrantExpiresAtMs: (raw as { timedGrantExpiresAtMs: number })
            .timedGrantExpiresAtMs,
        }
      : {}),
  };
  if ((raw as { responseNonce?: unknown }).responseNonce !== responseNonce) {
    return { approved: false, reason: 'Malformed permission response' };
  }
  if (
    !hasValidIpcResponseSignature(
      raw as Record<string, unknown>,
      responsePayload,
    )
  ) {
    return {
      approved: false,
      reason: 'Permission response signature verification failed',
    };
  }
  const mode =
    responsePayload.mode === 'allow_once' ||
    responsePayload.mode === 'allow_persistent_rule' ||
    responsePayload.mode === 'allow_timed_grant' ||
    responsePayload.mode === 'cancel'
      ? responsePayload.mode
      : undefined;
  const decisionClassification =
    responsePayload.decisionClassification === 'user_temporary' ||
    responsePayload.decisionClassification === 'user_permanent' ||
    responsePayload.decisionClassification === 'user_reject'
      ? responsePayload.decisionClassification
      : undefined;
  const sanitizedDecision = {
    approved: responsePayload.approved as boolean,
    mode,
    decisionClassification,
    updatedPermissions: Array.isArray(responsePayload.updatedPermissions)
      ? (responsePayload.updatedPermissions as never)
      : undefined,
  };
  return {
    approved: sanitizedDecision.approved,
    decidedBy:
      typeof responsePayload.decidedBy === 'string'
        ? responsePayload.decidedBy
        : undefined,
    reason:
      typeof responsePayload.reason === 'string'
        ? responsePayload.reason
        : undefined,
    mode,
    updatedPermissions: persistentPermissionUpdates(sanitizedDecision) as never,
    decisionClassification,
    timedGrantExpiresAtMs:
      typeof responsePayload.timedGrantExpiresAtMs === 'number'
        ? (responsePayload.timedGrantExpiresAtMs as number)
        : undefined,
  };
}

function deniedSocketPermissionDecision(reason: string): PermissionDecision {
  return {
    approved: false,
    reason,
    decisionClassification: 'user_reject',
  };
}

function socketPermissionFailureReason(err: unknown): string {
  return err instanceof Error
    ? err.message
    : 'Permission socket request failed';
}

export async function requestPermissionApproval(options: {
  appId?: string;
  agentId?: string;
  [AGENT_FOLDER_OPTION_KEY]: string;
  toolName: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  closestRule?: {
    rule: string;
    reason: string;
  };
  blockedPath?: string;
  toolInput?: unknown;
  toolUseID?: string;
  agentID?: string;
  suggestions?: unknown[];
  decisionOptions?: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  targetJid?: string;
  threadId?: string;
}): Promise<PermissionDecision> {
  try {
    const appId = options.appId?.trim() || APP_ID || DEFAULT_RUNNER_APP_ID;
    const agentId = options.agentId?.trim() || AGENT_ID;
    // `getBoundChatJid()` already returns the bound jid when present and falls
    // back to the spawn-env chatJid (trimmed) when unbound, so the old extra
    // `|| CHAT_JID` operand was dead — dropped. Cold path is byte-for-byte
    // unchanged (envIdentity() now trims GANTRY_CHAT_JID just like CHAT_JID did).
    const boundScope = getBoundRuntimeScope();
    const targetJid = options.targetJid?.trim() || boundScope.chatJid;
    const authThreadId = options.threadId ?? boundScope.threadId;
    const agentFolder = options[AGENT_FOLDER_OPTION_KEY];
    const requestFingerprint = permissionRequestFingerprint(options);
    const batchKey = timedGrantBatchKey({
      appId,
      agentId,
      targetJid,
      agentFolder,
      requestFingerprint,
    });
    const existingRequest = inFlightTimedGrantRequests.get(batchKey);
    if (existingRequest) {
      const sharedDecision = await existingRequest;
      if (canSharePermissionDecision(sharedDecision)) {
        return sharedDecision;
      }
    }
    const currentRequest = requestPermissionApprovalInner({
      ...options,
      appId,
      agentId,
      targetJid,
      ...(authThreadId ? { threadId: authThreadId } : {}),
    });
    inFlightTimedGrantRequests.set(batchKey, currentRequest);
    try {
      return await currentRequest;
    } finally {
      if (inFlightTimedGrantRequests.get(batchKey) === currentRequest) {
        inFlightTimedGrantRequests.delete(batchKey);
      }
    }
  } catch (err) {
    return {
      approved: false,
      reason:
        err instanceof Error
          ? `Permission request failed: ${err.message}`
          : 'Permission request failed',
    };
  }
}

async function requestPermissionApprovalInner(options: {
  appId: string;
  agentId?: string;
  [AGENT_FOLDER_OPTION_KEY]: string;
  toolName: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  closestRule?: {
    rule: string;
    reason: string;
  };
  blockedPath?: string;
  toolInput?: unknown;
  toolUseID?: string;
  agentID?: string;
  suggestions?: unknown[];
  decisionOptions?: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  targetJid?: string;
  threadId?: string;
}): Promise<PermissionDecision> {
  try {
    const appId = options.appId;
    const agentId = options.agentId;
    const targetJid = options.targetJid;
    const boundScope = getBoundRuntimeScope();
    const authThreadId = options.threadId ?? boundScope.threadId;
    const agentFolder = options[AGENT_FOLDER_OPTION_KEY];
    const requestId = `perm-${randomUUID()}`;
    const responseNonce = randomUUID();
    const payload = {
      requestId,
      appId,
      ...(agentId ? { agentId } : {}),
      responseNonce,
      sourceAgentFolder: agentFolder,
      ...(targetJid ? { targetJid } : {}),
      ...(process.env.GANTRY_AGENT_RUN_HANDLE
        ? { runHandle: process.env.GANTRY_AGENT_RUN_HANDLE }
        : {}),
      ...(JOB_ID ? { jobId: JOB_ID } : {}),
      ...(JOB_NAME ? { jobName: JOB_NAME } : {}),
      ...(JOB_RUN_ID ? { runId: JOB_RUN_ID } : {}),
      toolName: options.toolName,
      ...(options.title ? { title: options.title } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.decisionReason
        ? { decisionReason: options.decisionReason }
        : {}),
      ...(options.closestRule ? { closestRule: options.closestRule } : {}),
      ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      ...(isPlainObject(options.toolInput)
        ? { toolInput: options.toolInput }
        : {}),
      ...(options.toolUseID ? { toolUseID: options.toolUseID } : {}),
      ...(options.agentID ? { agentID: options.agentID } : {}),
      ...(options.suggestions ? { suggestions: options.suggestions } : {}),
      ...(options.decisionOptions
        ? { decisionOptions: options.decisionOptions }
        : {}),
      ...(options.semanticCapabilityDefinitions
        ? {
            semanticCapabilityDefinitions:
              options.semanticCapabilityDefinitions,
          }
        : {}),
      ...(authThreadId ? { threadId: authThreadId } : {}),
      context: {
        appId,
        ...(agentId ? { agentId } : {}),
        ...(targetJid ? { chatJid: targetJid } : {}),
        ...(JOB_ID ? { jobId: JOB_ID } : {}),
        ...(JOB_NAME ? { jobName: JOB_NAME } : {}),
        ...(JOB_RUN_ID ? { runId: JOB_RUN_ID } : {}),
        ...(authThreadId ? { threadId: authThreadId } : {}),
        ...((boundScope.ipcResponseKeyId ?? IPC_RESPONSE_KEY_ID)
          ? {
              responseKeyId: boundScope.ipcResponseKeyId ?? IPC_RESPONSE_KEY_ID,
            }
          : {}),
      },
      timestamp: nowIso(),
    };
    const envelope = createSignedIpcRequestEnvelope(
      boundScope.ipcAuthToken ?? IPC_AUTH_TOKEN,
      payload,
    );
    const socketClient = getActiveRunnerSocketClient();

    // Socket-only path: when the run's runner socket client is connected, send
    // the SAME signed envelope
    // over that ONE runner connection (the same one that receives
    // continuation/close pushes — never a second connection) and await the
    // signed decision. The client verifies the ed25519 response signature
    // fail-closed; we then re-check requestId/nonce binding + re-verify, then
    // sanitize.
    if (PERMISSION_REQUEST_TIMEOUT_MS <= 0) {
      return deniedSocketPermissionDecision(
        'Permission socket approval is disabled because permission waiting is disabled.',
      );
    }
    if (!socketClient?.connected) {
      return deniedSocketPermissionDecision(
        'Permission socket is not connected.',
      );
    }
    try {
      const resp = await socketClient.request('permission', envelope, {
        id: requestId,
        timeoutMs: PERMISSION_REQUEST_TIMEOUT_MS,
      });
      return decisionFromVerifiedPermissionResponse(
        resp,
        requestId,
        responseNonce,
      );
    } catch (err) {
      return deniedSocketPermissionDecision(
        `Permission socket request failed: ${socketPermissionFailureReason(err)}`,
      );
    }
  } catch (err) {
    return {
      approved: false,
      reason:
        err instanceof Error
          ? `Permission request failed: ${err.message}`
          : 'Permission request failed',
    };
  }
}
