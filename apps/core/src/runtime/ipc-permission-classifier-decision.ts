import { decisionForMode } from '../domain/permission-decision.js';
import type {
  ConversationRoute,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';
import { resolveEffectivePermissionMode } from '../shared/permission-mode.js';
import {
  findConversationRouteForQueue,
  makeAgentThreadQueueKey,
} from '../shared/thread-queue-key.js';
import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import type { IpcDeps } from './ipc-domain-types.js';
import {
  consultPermissionClassifierBeforePrompt,
  permissionPromotionHintCount,
  recordHumanPermissionPromotionSignal,
} from './permission-classifier.js';
import { runDurablePermissionInteraction } from '../application/interactions/durable-interaction-handler.js';

const FUTURE_MESSAGE_CURSOR = {
  timestamp: '9999-12-31T23:59:59.999Z',
  id: '\uffff',
};

export async function resolvePermissionIpcDecision(input: {
  request: PermissionApprovalRequest;
  trustedRunId?: string;
  sourceAgentFolder: string;
  deps: IpcDeps;
}): Promise<PermissionApprovalDecision> {
  const route = input.request.targetJid
    ? findConversationRouteForQueue(
        input.deps.conversationRoutes?.() ?? {},
        makeAgentThreadQueueKey(
          input.request.targetJid,
          agentIdForFolder(input.sourceAgentFolder),
          input.request.threadId,
          input.request.providerAccountId,
        ),
        (candidate) => agentIdForFolder(candidate.folder),
      )
    : undefined;
  const settings = input.deps.getPermissionRuntimeSettings?.();
  const approvedCapabilityIds =
    (
      settings?.agents[input.sourceAgentFolder] as
        | { capabilities?: Array<{ id: string }> }
        | null
        | undefined
    )?.capabilities?.map(({ id }) => id) ?? [];
  const autoModeModel = settings?.permissions.autoMode.model;
  const classifierConfig = settings
    ? {
        ...(autoModeModel ? { autoModeModel } : {}),
        memoryExtractorModel: settings.memory.llm.models.extractor,
      }
    : undefined;
  const permissionMode = resolveEffectivePermissionMode(
    route?.folder === input.sourceAgentFolder
      ? route.agentConfig?.permissionMode
      : undefined,
    settings?.agents[input.sourceAgentFolder]?.permissionMode,
  );
  const promotionRepository = input.deps.getPermissionPromotionRepository?.();
  const promotion = promotionRepository
    ? {
        repository: promotionRepository,
        offer: async (request: PermissionApprovalRequest) => {
          const interaction = await runDurablePermissionInteraction({
            request,
            sourceAgentFolder: input.sourceAgentFolder,
            prompt: input.deps.requestPermissionApproval,
          });
          if (interaction.resolved)
            recordHumanPermissionPromotionSignal({
              repository: promotionRepository,
              appId: request.appId,
              agentFolder: input.sourceAgentFolder,
              request,
              decision: interaction.decision,
            });
          return interaction;
        },
      }
    : undefined;
  const authority = await resolvePermissionAuthority(input, route);
  const shouldConsultClassifier =
    input.deps.publishRuntimeEvent &&
    classifierConfig &&
    permissionMode === 'auto' &&
    authority.trustedRequester;
  const intent = shouldConsultClassifier ? authority.intent : undefined;
  const classifierDecision =
    shouldConsultClassifier && intent
      ? await consultPermissionClassifierBeforePrompt({
          permissionMode,
          attended: input.request.unattended !== true,
          trustedRequester: authority.trustedRequester,
          requestFamily: input.request.requestFamily ?? 'tool',
          appId: input.request.appId,
          agentId: input.request.agentId,
          agentFolder: input.sourceAgentFolder,
          runId: input.trustedRunId,
          jobId: input.request.jobId,
          conversationId: input.request.targetJid,
          threadId: input.request.threadId,
          correlationId: input.request.requestId,
          actor: 'permission',
          intentSource: intent.source,
          turnIntentSummary: intent.summary,
          canonicalToolName: input.request.toolName,
          toolInput: input.request.toolInput,
          toolInputSanitized: input.request.toolInputSanitized,
          toolInputSanitizedPaths: input.request.toolInputSanitizedPaths,
          policyDecisionReason:
            input.request.decisionReason ?? 'Human approval is required.',
          approvedCapabilityIds,
          suggestions: input.request.suggestions,
          ...(promotion ? { promotion } : {}),
          classifierConfig: classifierConfig!,
          publishRuntimeEvent: input.deps.publishRuntimeEvent!,
          classifierConsult: input.deps.classifierConsult,
        })
      : undefined;

  if (classifierDecision?.decision === 'allow') {
    return decisionForMode(input.request, 'allow_once', 'auto_classifier');
  }
  if (permissionMode === 'auto' && input.request.unattended) {
    return {
      ...decisionForMode(input.request, 'cancel', 'runtime'),
      reason: classifierDecision
        ? `Classifier requested human approval: ${classifierDecision.reason}`
        : 'This tool is not eligible for unattended auto-permission.',
    };
  }
  input.request.promotionHintCount =
    classifierDecision?.promotionHintCount ??
    (await permissionPromotionHintCount({
      promotion,
      appId: input.request.appId,
      agentFolder: input.sourceAgentFolder,
      canonicalToolName: input.request.toolName,
      toolInput: input.request.toolInput,
      suggestions: input.request.suggestions,
    }));
  return input.deps.requestPermissionApproval(input.request);
}

async function resolvePermissionAuthority(
  input: Parameters<typeof resolvePermissionIpcDecision>[0],
  route: ConversationRoute | undefined,
): Promise<{
  trustedRequester: boolean;
  intent: {
    summary: string;
    source: 'operator_message' | 'none';
  };
}> {
  if (
    input.request.unattended &&
    input.request.jobId &&
    !input.request.senderId
  ) {
    return {
      trustedRequester: true,
      intent: { summary: '', source: 'none' },
    };
  }
  if (
    (route?.conversationKind !== 'dm' &&
      route?.conversationKind !== 'channel') ||
    !input.request.targetJid ||
    !input.deps.getPermissionMessageRepository ||
    !input.deps.isControlApproverAllowed
  ) {
    return untrustedPermissionAuthority();
  }
  try {
    const repository = input.deps.getPermissionMessageRepository();
    const messages = input.request.threadId
      ? await repository.getLatestThreadMessages(
          input.request.targetJid,
          input.request.threadId,
          FUTURE_MESSAGE_CURSOR,
          50,
          { providerAccountId: input.request.providerAccountId },
        )
      : await repository.getRecentTopLevelMessagesBefore(
          input.request.targetJid,
          FUTURE_MESSAGE_CURSOR,
          30,
          { providerAccountId: input.request.providerAccountId },
        );
    const checkedSenders = new Set<string>();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        !message ||
        message.is_from_me === true ||
        message.is_bot_message === true ||
        !message.content.trim() ||
        typeof message.sender !== 'string' ||
        !message.sender.trim() ||
        checkedSenders.has(message.sender)
      ) {
        continue;
      }
      if (checkedSenders.size >= 5) break;
      checkedSenders.add(message.sender);
      if (
        await input.deps.isControlApproverAllowed({
          conversationJid: input.request.targetJid,
          providerAccountId: input.request.providerAccountId,
          userId: message.sender,
          sourceAgentFolder: input.sourceAgentFolder,
          decisionPolicy: 'same_channel',
        })
      ) {
        return {
          trustedRequester: true,
          intent: {
            summary: message.content.trim().slice(0, 1_500),
            source: 'operator_message',
          },
        };
      }
    }
  } catch {
    return untrustedPermissionAuthority();
  }
  return untrustedPermissionAuthority();
}

function untrustedPermissionAuthority(): {
  trustedRequester: false;
  intent: { summary: ''; source: 'none' };
} {
  return {
    trustedRequester: false,
    intent: { summary: '', source: 'none' },
  };
}
