import {
  PermissionApprovalRequest,
  RichInteractionRequest,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import {
  DurableInteractionPersistenceError,
  recordDurableQuestionAnswerProgress,
  resolveDurableQuestionInteractionByRequestId,
} from '../application/interactions/pending-interaction-durability.js';
import {
  LIVE_STOP_CUSTOM_ID_PREFIX,
  parseQuestionCustomId,
  PERMISSION_CUSTOM_ID_PREFIX,
  QUESTION_CUSTOM_ID_PREFIX,
  SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX,
} from './discord-components.js';
import type { DiscordInteraction } from './discord-types.js';
import { RICH_INTERACTION_SUBMITTED_BY_COPY } from './rich-interaction.js';
import {
  DISCORD_RICH_FORM_OPEN_PREFIX,
  openDiscordRichFormInteraction,
  renderDiscordRichInteraction,
} from './discord-rich-interaction.js';
import {
  DISCORD_API_ROOT,
  discordChannelIdFromJid,
  discordGantrySlashText,
  discordHeaders,
  discordUserName,
} from './discord-interaction-helpers.js';
import { DISCORD_PERMISSION_FULL_VIEW_PREFIX } from './discord-permission-full-view.js';
import {
  DiscordInteractionInput,
  DiscordPermissionInteractions,
} from './discord-permission-interactions.js';
import {
  dropPendingDiscordQuestions,
  requestDiscordUserAnswer,
  resolvePendingDiscordQuestionsOnDisconnect,
  type PendingDiscordQuestion,
} from './discord-user-question-delivery.js';

const DISCORD_RICH_FORM_SUBMIT_PREFIX = 'gantry:rich_form_submit:';

export class DiscordInteractionHandler extends DiscordPermissionInteractions {
  private pendingQuestions = new Map<string, PendingDiscordQuestion>();
  private readonly richForms = new Map<string, RichInteractionRequest>();

  constructor(input: DiscordInteractionInput) {
    super(input);
  }

  dropPendingInteraction(
    kind: 'permission' | 'question',
    request: PermissionApprovalRequest | UserQuestionRequest,
  ): void {
    if (kind === 'permission') this.dropPendingPermission(request);
    else dropPendingDiscordQuestions(this.pendingQuestions, request);
  }

  async renderRichInteraction(
    jid: string,
    render: RichInteractionRequest,
  ): Promise<boolean> {
    return renderDiscordRichInteraction({
      jid,
      channelId: render.threadId || discordChannelIdFromJid(jid),
      render,
      richForms: this.richForms,
      postMessage: (channelId, body) => this.input.postMessage(channelId, body),
      sendFallback: (text, options) =>
        this.input.sendMessage(jid, text, options),
    });
  }

  async requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
    onPromptDelivered?: (messageId: string, questionIndex?: number) => void,
  ): Promise<UserQuestionResponse> {
    return requestDiscordUserAnswer({
      jid,
      request,
      pendingQuestions: this.pendingQuestions,
      sendPrompt: (targetJid, text, options) =>
        this.sendDiscordPrompt(targetJid, text, options),
      onPromptDelivered,
    });
  }

  async handleInteraction(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.id || !interaction.token || !interaction.channel_id)
      return;
    if (interaction.type === 3) {
      const customId = interaction.data?.custom_id || '';
      if (customId.startsWith(LIVE_STOP_CUSTOM_ID_PREFIX)) {
        await this.ackInteraction(interaction, 'Checking stop request.');
        const context = await this.input.resolveInteractionConversationContext(
          interaction.channel_id,
        );
        await this.input.opts.onMessageAction?.({
          kind: 'live_turn_stop',
          conversationJid: context.conversationJid,
          providerAccountId: this.input.opts.providerAccountId,
          ...(context.threadId ? { threadId: context.threadId } : {}),
          userId: interaction.member?.user?.id || interaction.user?.id,
          actionToken: customId.slice(LIVE_STOP_CUSTOM_ID_PREFIX.length),
        });
        return;
      }
      if (customId.startsWith(SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX)) {
        await this.ackInteraction(interaction, 'Checking retry request.');
        const context = await this.input.resolveInteractionConversationContext(
          interaction.channel_id,
        );
        await this.input.opts.onMessageAction?.({
          kind: 'scheduler_run_now',
          conversationJid: context.conversationJid,
          providerAccountId: this.input.opts.providerAccountId,
          ...(context.threadId ? { threadId: context.threadId } : {}),
          userId: interaction.member?.user?.id || interaction.user?.id,
          jobId: decodeURIComponent(
            customId.slice(SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX.length),
          ),
        });
        return;
      }
      if (customId.startsWith(PERMISSION_CUSTOM_ID_PREFIX)) {
        await this.handlePermissionInteraction(interaction, customId);
        return;
      }
      if (customId.startsWith(DISCORD_PERMISSION_FULL_VIEW_PREFIX)) {
        await this.handlePermissionFullView(interaction, customId);
        return;
      }
      if (customId.startsWith(QUESTION_CUSTOM_ID_PREFIX)) {
        await this.handleQuestionInteraction(interaction, customId);
        return;
      }
      if (customId.startsWith(DISCORD_RICH_FORM_OPEN_PREFIX)) {
        await this.openRichFormInteraction(interaction, customId);
      }
      return;
    }
    if (interaction.type === 5) {
      const customId = interaction.data?.custom_id || '';
      if (customId.startsWith(DISCORD_RICH_FORM_SUBMIT_PREFIX)) {
        this.richForms.delete(
          customId.slice(DISCORD_RICH_FORM_SUBMIT_PREFIX.length),
        );
        const user = interaction.member?.user || interaction.user;
        await this.ackInteraction(
          interaction,
          `${RICH_INTERACTION_SUBMITTED_BY_COPY} ${discordUserName(user)}.`,
        );
      }
      return;
    }
    if (interaction.type !== 2 || interaction.data?.name !== 'gantry') return;
    const commandText = discordGantrySlashText(interaction);
    await this.ackInteraction(interaction, `Gantry received ${commandText}.`);
    const user = interaction.member?.user || interaction.user;
    const context = await this.input.resolveInteractionConversationContext(
      interaction.channel_id,
    );
    await this.input.opts.onMessage(context.conversationJid, {
      id: interaction.id,
      chat_jid: context.conversationJid,
      provider: 'discord',
      sender: user?.id || 'unknown',
      sender_name: interaction.member?.nick || discordUserName(user),
      content: commandText,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
      thread_id: context.threadId,
      external_message_id: interaction.id,
    });
  }

  async clearPendingInteractions(): Promise<void> {
    await this.clearPendingPermissionPrompts();
    resolvePendingDiscordQuestionsOnDisconnect(this.pendingQuestions);
  }

  private async handleQuestionInteraction(
    interaction: DiscordInteraction,
    customId: string,
  ): Promise<void> {
    const parsed = parseQuestionCustomId(customId);
    const pending = parsed
      ? this.pendingQuestions.get(parsed.providerAlias)
      : undefined;
    if (!parsed) {
      await this.ackInteraction(
        interaction,
        'This question is no longer active.',
      );
      return;
    }
    const deferAcknowledgement = Boolean(
      pending &&
      parsed.optionIndex >= 0 &&
      pending.callbacks.some(
        (callback) =>
          callback.providerAlias === parsed.providerAlias &&
          pending.request.questions[callback.questionIndex]?.multiSelect,
      ),
    );
    if (!deferAcknowledgement) {
      await this.ackInteraction(interaction, 'Processing.');
    }
    const user = interaction.member?.user || interaction.user;
    if (!pending) return;
    const allowed = await this.isInteractionApproverAllowed(
      interaction,
      user?.id,
      pending.request.sourceAgentFolder,
    );
    const callback = pending.callbacks.find(
      (candidate) => candidate.providerAlias === parsed.providerAlias,
    );
    if (!callback) return;
    const questionIndex = callback.questionIndex;
    const question = pending.request.questions[questionIndex];
    const option =
      parsed.optionIndex >= 0
        ? question?.options[parsed.optionIndex]
        : undefined;
    if (!allowed || !question || (parsed.optionIndex >= 0 && !option)) {
      if (deferAcknowledgement) {
        await this.ackInteraction(
          interaction,
          'This question is no longer active.',
        );
      }
      return;
    }
    if (question.multiSelect) {
      const selected = new Set(
        Array.isArray(pending.answers[question.question])
          ? (pending.answers[question.question] as string[])
          : [],
      );
      if (parsed.optionIndex < 0) {
        pending.answers[question.question] = [...selected];
        pending.finalizedQuestions.add(questionIndex);
      } else if (option) {
        const recorded = await resolveDurableQuestionInteractionByRequestId({
          requestId: pending.request.requestId,
          appId: pending.request.appId,
          sourceAgentFolder: pending.request.sourceAgentFolder,
          questionIndex,
          optionIndex: parsed.optionIndex,
          finalize: false,
        });
        if (!recorded) {
          throw new DurableInteractionPersistenceError(
            'Discord user question selection was not persisted',
          );
        }
        if (selected.has(option.label)) {
          selected.delete(option.label);
        } else {
          selected.add(option.label);
        }
        pending.answers[question.question] = [...selected];
        await this.ackInteraction(interaction, 'Processing.');
        return;
      }
    } else if (option) {
      pending.answers[question.question] = option.label;
      pending.finalizedQuestions.add(questionIndex);
    }
    if (pending.finalizedQuestions.has(questionIndex)) {
      const recorded = await recordDurableQuestionAnswerProgress({
        requestId: pending.request.requestId,
        appId: pending.request.appId,
        sourceAgentFolder: pending.request.sourceAgentFolder,
        answers: {
          [question.question]: pending.answers[question.question]!,
        },
      });
      if (!recorded) return;
    }
    if (pending.finalizedQuestions.size < pending.request.questions.length) {
      return;
    }
    clearTimeout(pending.timeout);
    for (const questionCallback of pending.callbacks) {
      this.pendingQuestions.delete(questionCallback.providerAlias);
    }
    pending.resolve({
      requestId: pending.request.requestId,
      answers: pending.answers,
      answeredBy: user?.id,
    });
  }

  private async openRichFormInteraction(
    interaction: DiscordInteraction,
    customId: string,
  ): Promise<void> {
    await openDiscordRichFormInteraction({
      apiRoot: DISCORD_API_ROOT,
      headers: discordHeaders(this.input.botToken),
      interaction,
      customId,
      richForms: this.richForms,
      ackInteraction: (message) => this.ackInteraction(interaction, message),
    });
  }
}
