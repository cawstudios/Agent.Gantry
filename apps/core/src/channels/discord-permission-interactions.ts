import {
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
} from '../domain/types.js';
import {
  claimPermissionInteractionCallback,
  DurableInteractionPersistenceError,
  releasePermissionInteractionCallback,
} from '../application/interactions/pending-interaction-durability.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../shared/permission-timeout.js';
import {
  buildPermissionPromptParts,
  decisionForMode,
  formatPermissionPromptPartsText,
  permissionButtonLabel,
  permissionDecisionOptions,
} from './permission-interaction.js';
import { type ChannelOpts } from './channel-provider.js';
import { buttonRows, permissionCustomId } from './discord-components.js';
import {
  postDiscordMessageParts,
  splitDiscordText,
} from './discord-delivery.js';
import type { DiscordInteraction } from './discord-types.js';
import {
  ackDiscordInteraction,
  DISCORD_JID_PREFIX,
  discordChannelIdFromJid,
  updateDiscordInteractionResponse,
} from './discord-interaction-helpers.js';
import { bindDiscordPermissionPrompt } from './discord-prompt-binding.js';
import * as permissionPrompt from './discord-permission-prompt-settlement.js';
import { handleDiscordPermissionCallback } from './discord-permission-callback.js';
import {
  discordPermissionFullViewCustomId,
  handleDiscordPermissionFullView,
} from './discord-permission-full-view.js';

type DiscordConversationContext = {
  conversationJid: string;
  threadId?: string;
};

export type DiscordInteractionInput = {
  botToken: string;
  applicationId: string;
  opts: ChannelOpts;
  postMessage: (
    channelId: string,
    body: Record<string, unknown>,
  ) => Promise<{ id?: string }>;
  sendMessage: (
    jid: string,
    text: string,
    options?: MessageSendOptions,
  ) => Promise<MessageDeliveryResult>;
  resolveInteractionConversationContext: (
    channelId: string,
  ) => Promise<DiscordConversationContext>;
};

type PendingPermission = ReturnType<typeof permissionPrompt.pending>;

export abstract class DiscordPermissionInteractions {
  protected pendingPermissions = new Map<string, PendingPermission>();

  constructor(protected readonly input: DiscordInteractionInput) {}

  protected dropPendingPermission(
    request: Pick<
      PermissionApprovalRequest,
      'appId' | 'sourceAgentFolder' | 'requestId'
    >,
  ): void {
    permissionPrompt.drop(this.pendingPermissions, request);
  }

  async requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
    onPromptDelivered?: (messageId: string) => void,
  ): Promise<PermissionApprovalDecision> {
    const callback = {
      providerAlias: globalThis.crypto.randomUUID(),
      scope: {
        appId: request.appId || 'default',
        sourceAgentFolder: request.sourceAgentFolder,
        interactionId: request.requestId,
      },
      matchKind: request.permissionBatch
        ? ('batch' as const)
        : ('individual' as const),
    };
    const modes = permissionDecisionOptions(request);
    const parts = buildPermissionPromptParts(
      request,
      PERMISSION_APPROVAL_TIMEOUT_MS,
    );
    const buttons = [
      ...(parts.fullView
        ? [
            {
              label: parts.fullView.label,
              style: 2,
              custom_id: discordPermissionFullViewCustomId(
                callback.providerAlias,
              ),
            },
          ]
        : []),
      ...modes.map((mode) => ({
        label: permissionButtonLabel(mode, request),
        style: mode === 'cancel' ? 4 : 1,
        custom_id: permissionCustomId(callback.providerAlias, mode),
      })),
    ];
    const conversationId = discordChannelIdFromJid(jid) || jid;
    if (
      !(await bindDiscordPermissionPrompt(
        request,
        conversationId,
        callback.providerAlias,
      ))
    ) {
      return {
        approved: false,
        mode: 'cancel',
        reason: 'Discord permission callback binding failed',
      };
    }
    const sent = await this.sendDiscordPrompt(
      jid,
      formatPermissionPromptPartsText(parts),
      {
        threadId: request.threadId,
        components: buttonRows(buttons),
      },
    );
    let resolveDecision!: (decision: PermissionApprovalDecision) => void;
    const decision = new Promise<PermissionApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const timeout = setTimeout(() => {
      void this.timeoutPermissionPrompt(callback.providerAlias);
    }, PERMISSION_APPROVAL_TIMEOUT_MS);
    timeout.unref?.();
    const livePending = permissionPrompt.pending(
      callback,
      request,
      sent,
      request.threadId || conversationId,
      resolveDecision,
      timeout,
    );
    this.pendingPermissions.set(callback.providerAlias, livePending);
    if (sent.externalMessageId) {
      try {
        const bound = await bindDiscordPermissionPrompt(
          request,
          conversationId,
          callback.providerAlias,
          sent.externalMessageIds?.at(-1) ?? sent.externalMessageId,
          parts.fullView,
        );
        if (!bound)
          throw new Error('Discord permission message binding failed');
      } catch (err) {
        if (err instanceof DurableInteractionPersistenceError) throw err;
        clearTimeout(timeout);
        if (this.pendingPermissions.get(callback.providerAlias) === livePending)
          this.pendingPermissions.delete(callback.providerAlias);
        resolveDecision({
          approved: false,
          mode: 'cancel',
          reason: 'Failed to bind Discord approval prompt',
        });
        return decision;
      }
    } else {
      clearTimeout(timeout);
      if (this.pendingPermissions.get(callback.providerAlias) === livePending)
        this.pendingPermissions.delete(callback.providerAlias);
      resolveDecision({
        approved: false,
        mode: 'cancel',
        reason: 'Discord permission message id missing',
      });
      return decision;
    }
    if (sent.externalMessageId) onPromptDelivered?.(sent.externalMessageId);
    return decision;
  }

  protected async clearPendingPermissionPrompts(): Promise<void> {
    for (const providerAlias of this.pendingPermissions.keys()) {
      const result = await this.settlePermissionPrompt(
        providerAlias,
        'cancel',
        'system',
        'channel disconnected',
      );
      if (result === 'already_decided') continue;
      const pending = this.pendingPermissions.get(providerAlias);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.pendingPermissions.delete(providerAlias);
      pending.resolve({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'channel disconnected',
      });
    }
  }

  private async settlePermissionPrompt(
    providerAlias: string,
    mode: PermissionApprovalDecisionMode,
    approverRef: string,
    reason: string,
  ): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'> {
    const pending = this.pendingPermissions.get(providerAlias);
    if (!pending) return 'already_decided';
    const claimed = await claimPermissionInteractionCallback({
      scope: pending.callback.scope,
      mode,
      approverRef,
      matchKind: pending.callback.matchKind,
      providerAlias,
    });
    if (claimed.status === 'already_decided')
      return claimed.ownerless ? 'ownerless' : 'already_decided';
    if (claimed.status === 'retryable') return 'retryable';
    const decision = {
      ...decisionForMode(pending.request, mode, approverRef),
      reason,
      permissionCallbackClaim: claimed.claim,
    };
    if (
      !(await permissionPrompt.settle(
        this.pendingPermissions,
        providerAlias,
        decision,
        this.input,
      ))
    ) {
      await releasePermissionInteractionCallback({ claim: claimed.claim });
      return 'retryable';
    }
    return 'settled';
  }

  private async timeoutPermissionPrompt(providerAlias: string): Promise<void> {
    let result = await this.settlePermissionPrompt(
      providerAlias,
      'cancel',
      'system',
      'timed out',
    );
    if (result === 'settled') return;
    if (result === 'already_decided') return;
    if (result === 'retryable') {
      for (const delayMs of permissionPrompt.timeoutRetryDelays(
        PERMISSION_APPROVAL_TIMEOUT_MS,
      )) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref?.();
        });
        if (!this.pendingPermissions.has(providerAlias)) return;
        result = await this.settlePermissionPrompt(
          providerAlias,
          'cancel',
          'system',
          'timed out',
        );
        if (result !== 'retryable') break;
      }
    }
    if (result === 'already_decided') return;
    const pending = this.pendingPermissions.get(providerAlias);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingPermissions.delete(providerAlias);
    pending.resolve({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'timed out',
    });
  }

  protected async sendDiscordPrompt(
    jid: string,
    text: string,
    options: { threadId?: string; components?: unknown[] } = {},
  ): Promise<MessageDeliveryResult> {
    const channelId = options.threadId || discordChannelIdFromJid(jid);
    if (!channelId) throw new Error(`Invalid Discord conversation id: ${jid}`);
    return postDiscordMessageParts({
      channelId,
      parts: splitDiscordText(text),
      components: options.components,
      post: (target, body) => this.input.postMessage(target, body),
    });
  }

  protected async handlePermissionInteraction(
    interaction: DiscordInteraction,
    customId: string,
  ): Promise<void> {
    await handleDiscordPermissionCallback({
      appId: this.input.opts.appId || 'default',
      interaction,
      customId,
      pendingPermissions: this.pendingPermissions,
      botToken: this.input.botToken,
      ack: (content) => this.ackInteraction(interaction, content),
      feedback: (content) =>
        updateDiscordInteractionResponse(
          this.input.applicationId,
          interaction,
          content,
        ),
      resolveConversationContext: (channelId) =>
        this.input.resolveInteractionConversationContext(channelId),
      isApproverAllowed: (userId, folder, policy, threadId, conversationJid) =>
        this.isInteractionApproverAllowed(
          interaction,
          userId,
          folder,
          policy,
          threadId,
          conversationJid,
        ),
    });
  }

  protected async handlePermissionFullView(
    interaction: DiscordInteraction,
    customId: string,
  ): Promise<void> {
    await handleDiscordPermissionFullView({
      interaction,
      customId,
      appId: this.input.opts.appId || 'default',
      applicationId: this.input.applicationId,
      botToken: this.input.botToken,
      timeoutMs: PERMISSION_APPROVAL_TIMEOUT_MS,
      pendingPermissions: this.pendingPermissions,
      resolveConversationContext: (channelId) =>
        this.input.resolveInteractionConversationContext(channelId),
      isApproverAllowed: (
        userId,
        sourceAgentFolder,
        decisionPolicy,
        threadId,
        conversationJid,
      ) =>
        this.isInteractionApproverAllowed(
          interaction,
          userId,
          sourceAgentFolder,
          decisionPolicy,
          threadId,
          conversationJid,
        ),
      acknowledge: (content) => this.ackInteraction(interaction, content),
    });
  }

  protected async isInteractionApproverAllowed(
    interaction: DiscordInteraction,
    userId: string | undefined,
    sourceAgentFolder: string,
    decisionPolicy: PermissionApprovalRequest['decisionPolicy'] = 'same_channel',
    threadId?: string,
    conversationJid = `${DISCORD_JID_PREFIX}${interaction.channel_id}`,
  ): Promise<boolean> {
    if (!userId || !this.input.opts.isControlApproverAllowed) return false;
    return this.input.opts.isControlApproverAllowed({
      providerId: 'discord',
      providerAccountId: this.input.opts.providerAccountId,
      agentId: this.input.opts.agentId,
      conversationJid,
      threadId,
      userId,
      sourceAgentFolder,
      decisionPolicy,
    });
  }

  protected async ackInteraction(
    interaction: DiscordInteraction,
    content: string,
  ): Promise<void> {
    await ackDiscordInteraction(this.input.botToken, interaction, content);
  }
}
