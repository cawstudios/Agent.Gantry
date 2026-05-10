import fs from 'fs';
import path from 'path';
import {
  MemoryIpcAction,
  MEMORY_IPC_ACTIONS,
  MemoryIpcRequest,
  MemoryIpcResponse,
} from '@myclaw/contracts';

import { signIpcResponsePayload } from '../infrastructure/ipc/response-signing.js';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../shared/private-fs.js';
import { logger } from '../infrastructure/logging/logger.js';
import { resolveGroupIpcPath } from '../platform/group-folder.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from './app-memory-boundaries.js';
import {
  resolveScopedMemorySubject,
  canonicalConversationIdForMemory,
  searchInputForResolvedMemorySubject,
} from './app-memory-subject-resolver.js';
import { describeAppMemorySearchOutcome } from './app-memory-recall.js';
import { AppMemoryService } from './app-memory-service.js';
import {
  parseDemoteMemoryInput,
  parsePatchMemoryInput,
  parsePatchProcedureInput,
  parseReviewDecisionInput,
  parseSaveMemoryInput,
  parseSaveProcedureInput,
} from './memory-ipc-parsing.js';
export {
  parseOptionalNumber,
  parseOptionalString,
} from './memory-ipc-parsing.js';
import { SaveMemoryInput, SaveProcedureInput } from './memory-types.js';

const MEMORY_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

interface TrustedMemoryContext {
  threadId?: string;
  chatJid?: string;
  userId?: string;
  defaultScope?: 'user' | 'group';
  reviewerIsControlApprover?: boolean;
}

type TrustedMemoryRequest = Omit<MemoryIpcRequest, 'context'> & {
  context?: TrustedMemoryContext;
  allowedActions?: readonly MemoryIpcAction[];
};

const DEFAULT_ALLOWED_MEMORY_IPC_ACTIONS = new Set<MemoryIpcAction>([
  'memory_search',
  'memory_save',
  'continuity_summary',
  'procedure_save',
]);

type SubjectForMemoryIpc = ReturnType<typeof resolveTrustedMemorySubject>;
type MemoryDemoteService = {
  demote(input: Record<string, unknown>): Promise<unknown>;
};

function asMemoryDemoteService(memory: AppMemoryService): MemoryDemoteService {
  const candidate = memory as unknown as Partial<MemoryDemoteService>;
  if (typeof candidate.demote === 'function') {
    return candidate as MemoryDemoteService;
  }
  throw new Error(
    'memory demote service is unavailable; AppMemoryService.demote(input) is required',
  );
}

function assertValidRequestId(requestId: string): void {
  if (!MEMORY_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid memory IPC requestId');
  }
}

function assertMemoryActionAllowed(request: TrustedMemoryRequest): void {
  if (!MEMORY_IPC_ACTIONS.includes(request.action)) {
    throw new Error(`Unsupported memory action: ${request.action}`);
  }
  const allowedActions =
    request.allowedActions && request.allowedActions.length > 0
      ? new Set(request.allowedActions)
      : DEFAULT_ALLOWED_MEMORY_IPC_ACTIONS;
  if (!allowedActions.has(request.action)) {
    throw new Error(`Memory IPC action is not allowed: ${request.action}`);
  }
}

export function resolveTrustedMemorySubject(
  sourceAgentFolder: string,
  context: TrustedMemoryContext | undefined,
  scope?: SaveMemoryInput['scope'] | SaveProcedureInput['scope'],
) {
  return resolveScopedMemorySubject({
    appId: DEFAULT_MEMORY_APP_ID,
    agentId: memoryAgentIdForGroupFolder(sourceAgentFolder),
    groupId: sourceAgentFolder,
    conversationId: canonicalConversationIdForMemory(context?.chatJid),
    userId: context?.userId,
    threadId: context?.threadId,
    defaultScope: context?.defaultScope,
    ...(scope ? { scope } : {}),
  }).subject;
}

export async function processMemoryRequest(
  request: TrustedMemoryRequest,
  sourceAgentFolder: string,
): Promise<MemoryIpcResponse> {
  let provider = 'uninitialized';

  try {
    assertValidRequestId(request.requestId);
    assertMemoryActionAllowed(request);
    const memory = AppMemoryService.getInstance();
    provider = 'postgres';
    logger.debug(
      { action: request.action, sourceAgentFolder, provider },
      'Processing memory IPC request',
    );

    switch (request.action) {
      case 'memory_search': {
        const query = String(request.payload.query || '').trim();
        if (!query) {
          throw new Error('query is required');
        }
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        // IPC memory reads are always scoped to the source group to prevent
        // cross-group data access from agent processes.
        const searchInput = {
          query,
          ...searchInputForResolvedMemorySubject(subject),
          ...(request.payload.limit
            ? { limit: Number(request.payload.limit) }
            : {}),
        };
        const results = await memory.search(searchInput);
        const outcome = describeAppMemorySearchOutcome(
          searchInput,
          results.length,
        );
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: {
            results,
            resolved_subject: outcome.resolvedSubject,
            ...(outcome.empty_reason
              ? { empty_reason: outcome.empty_reason }
              : {}),
          },
        };
      }
      case 'memory_save': {
        const input = {
          ...parseSaveMemoryInput(request.payload),
          ...(request.context?.threadId
            ? { topic_id: request.context.threadId }
            : {}),
        };
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
          input.scope,
        );
        const saved = await memory.save({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          kind: input.kind,
          key: input.key,
          value: input.value,
          why: input.why,
          confidence: input.confidence,
          source: input.source || 'mcp-tool',
          actorId: 'mcp-tool',
          isAdminWrite: false,
          evidenceText: input.why || input.value,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { memory: saved },
        };
      }
      case 'memory_patch': {
        const input = parsePatchMemoryInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const patched = await memory.patch({
          ...subject,
          id: input.id,
          appId: DEFAULT_MEMORY_APP_ID,
          agentId: memoryAgentIdForGroupFolder(sourceAgentFolder),
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          key: input.key,
          value: input.value,
          why: input.why,
          confidence: input.confidence,
          isPinned: input.load_bearing,
          expectedVersion: input.expected_version,
          isAdminWrite: false,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { memory: patched },
        };
      }
      case 'memory_demote': {
        const input = parseDemoteMemoryInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const demoted = await asMemoryDemoteService(memory).demote({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          id: input.id,
          ...(input.expectedVersion !== undefined
            ? { expectedVersion: input.expectedVersion }
            : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          actorId: 'mcp-tool',
          isAdminWrite: false,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { memory: demoted },
        };
      }
      case 'continuity_summary': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const continuity = await memory.continuitySummary(subject);
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { continuity },
        };
      }
      case 'memory_consolidate': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const result = await memory.triggerDreaming({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          phase: 'deep',
          dryRun: false,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { consolidation: result },
        };
      }
      case 'memory_dream': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const result = await memory.triggerDreaming({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          phase: 'all',
          dryRun: false,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { dreaming: result },
        };
      }
      case 'memory_review_pending': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const reviews = await memory.listPendingReviews({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { reviews },
        };
      }
      case 'memory_review_decision': {
        const input = parseReviewDecisionInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        if (!request.context?.userId) {
          throw new Error(
            'memory_review_decision requires a trusted reviewer user id',
          );
        }
        if (!request.context.reviewerIsControlApprover) {
          throw new Error(
            'memory_review_decision requires a conversation control approver',
          );
        }
        const review = await memory.decideReview({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          ...input,
          reviewerId: request.context.userId,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { review },
        };
      }
      case 'procedure_save': {
        const input = {
          ...parseSaveProcedureInput(request.payload),
          ...(request.context?.threadId
            ? { topic_id: request.context.threadId }
            : {}),
        };
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
          input.scope,
        );
        const saved = await memory.save({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          kind: 'reference',
          key: `procedure:${input.title}`,
          value: input.body,
          why: input.trigger || undefined,
          confidence: input.confidence,
          source: input.source || 'mcp-tool',
          actorId: 'mcp-tool',
          isAdminWrite: false,
          evidenceText: input.body,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { procedure: saved },
        };
      }
      case 'procedure_patch': {
        const input = parsePatchProcedureInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const patched = await memory.patch({
          ...subject,
          id: input.id,
          appId: DEFAULT_MEMORY_APP_ID,
          agentId: memoryAgentIdForGroupFolder(sourceAgentFolder),
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          key: input.title ? `procedure:${input.title}` : undefined,
          value: input.body,
          why: input.trigger === null ? null : input.trigger,
          confidence: input.confidence,
          expectedVersion: input.expected_version,
          isAdminWrite: false,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { procedure: patched },
        };
      }
      default:
        throw new Error(
          `Unsupported memory action: ${(request as { action?: string }).action || 'unknown'}`,
        );
    }
  } catch (err) {
    return {
      ok: false,
      requestId: request.requestId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function writeMemoryResponse(
  groupFolder: string,
  requestId: string,
  response: MemoryIpcResponse,
  privateKeyPem?: string,
): void {
  assertValidRequestId(requestId);
  const ipcDir = resolveGroupIpcPath(groupFolder);
  const responsesDir = path.join(ipcDir, 'memory-responses');
  ensurePrivateDirSync(responsesDir);

  const filePath = path.join(responsesDir, `${requestId}.json`);
  const tmpPath = `${filePath}.tmp`;
  const payload: Record<string, unknown> = {
    ok: response.ok,
    requestId: response.requestId,
    ...(response.provider ? { provider: response.provider } : {}),
    ...(response.data !== undefined ? { data: response.data } : {}),
    ...(response.error ? { error: response.error } : {}),
  };
  const signature = signIpcResponsePayload(privateKeyPem, payload);
  if (!signature) return;
  payload.signature = signature;
  writePrivateFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, filePath);
}
