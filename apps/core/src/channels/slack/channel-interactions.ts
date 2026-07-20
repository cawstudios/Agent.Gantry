import { SlackMessageLike } from './channel-state.js';
import { registerSlackRichFormHandlers } from './rich-interaction.js';
import { registerSlackMessageActionHandler } from './channel-message-action-handler.js';
import { registerSlackUtilityHandlers } from './channel-utility-handlers.js';
import {
  ingestSlackMessage as ingestSlackMessageEvent,
  ingestSlackSlashCommand as ingestSlackSlashCommandEvent,
} from './channel-message-ingest.js';
import { SlackChannelPermissionInteractions } from './channel-permission-interactions.js';
import { registerSlackUserQuestionHandlers } from './user-question-interactions.js';

export abstract class SlackChannelInteractions extends SlackChannelPermissionInteractions {
  protected async ingestSlackSlashCommand(command: {
    channel_id?: string;
    user_id?: string;
    user_name?: string;
    text?: string;
    trigger_id?: string;
    command_id?: string;
  }): Promise<void> {
    await ingestSlackSlashCommandEvent({
      command,
      opts: this.opts,
      resolveChannelName: (channelId) => this.resolveChannelName(channelId),
      resolveUserName: (userId) => this.resolveUserName(userId),
      isLikelyGroupConversation: (channelId) =>
        this.isLikelyGroupConversation(channelId),
    });
  }

  protected async ingestSlackMessage(
    event: SlackMessageLike,
    options: { forceOwnedTopLevel?: boolean } = {},
  ): Promise<void> {
    await ingestSlackMessageEvent({
      event,
      options,
      opts: this.opts,
      botUserId: this.botUserId,
      resolveChannelName: (channelId) => this.resolveChannelName(channelId),
      resolveUserName: (userId) => this.resolveUserName(userId),
      isLikelyGroupConversation: (channelId) =>
        this.isLikelyGroupConversation(channelId),
      enrichMessage: (jid, slackEvent, targetFolder) =>
        this.enrichMessage(jid, slackEvent, targetFolder),
    });
  }

  protected registerBoltHandlers(options: { inbound?: boolean } = {}): void {
    if (!this.app) return;
    if (options.inbound !== false) {
      this.app.event('message', async (args: any) => {
        await this.ingestSlackMessage(args.event as SlackMessageLike);
      });
      this.app.event('app_mention', async (args: any) => {
        await this.ingestSlackMessage(args.event as SlackMessageLike, {
          forceOwnedTopLevel: true,
        });
      });
      this.app.command('/gantry', async (args: any) => {
        await args.ack();
        await this.ingestSlackSlashCommand(args.command || args.body || {});
      });
      registerSlackUtilityHandlers(this.app);
    }
    this.registerSlackPermissionHandlers();
    registerSlackUserQuestionHandlers({
      app: this.app,
      pendingUserQuestions: this.pendingUserQuestions,
      parseActionValue: (value) => this.parseUserQuestionActionValue(value),
      pendingKey: (callback) => this.pendingUserQuestionKey(callback),
      canAnswer: (userId, sourceAgentFolder, conversationJid) =>
        this.canDecidePermission(
          userId,
          sourceAgentFolder,
          undefined,
          conversationJid,
        ),
      refreshPrompt: (pending) => this.refreshUserQuestionPrompt(pending),
      finalizePrompt: (pending, selection, answeredBy) =>
        this.finalizeUserQuestionPrompt(pending, selection, answeredBy),
    });
    registerSlackRichFormHandlers({
      app: this.app,
      pendingRichForms: this.pendingRichForms,
    });
    registerSlackMessageActionHandler(this.app, this.opts);
  }
}
