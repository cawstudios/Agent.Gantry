import type { ChannelOpts } from './channel-provider.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import type { TeamsAdaptiveCardPayload } from './teams-cards.js';

export const TEAMS_JID_PREFIX = 'teams:';

export interface TeamsChannelCredentials {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  botAppId?: string;
  botAppPassword?: string;
  botTenantId?: string;
}

// Keep Microsoft SDK shapes behind this adapter-owned interface so domain,
// application, and tests do not depend on Bot Framework or Graph SDK types.
export interface TeamsInboundMessage {
  conversationId: string;
  id?: string;
  text?: string;
  name?: string;
  value?: unknown;
  from?: {
    id?: string;
    name?: string;
  };
  senderId?: string;
  senderName?: string;
  senderIdKind?:
    | 'aad_object_id'
    | 'teams_user_id'
    | 'user_principal_name'
    | 'unknown';
  tenantId?: string;
  timestamp?: string;
  threadId?: string;
  replyToId?: string;
  conversationName?: string;
  conversationType?: string;
}

export interface TeamsSdkStartInput {
  credentials: TeamsChannelCredentials;
  onMessage: (message: TeamsInboundMessage) => Promise<void>;
}

export interface TeamsSdkSendResult {
  externalMessageId?: string;
}

export interface TeamsSdkOutboundMessage {
  conversationId: string;
  text: string;
  threadId?: string;
}

export interface TeamsSdkAdaptiveCardMessage {
  conversationId: string;
  card: TeamsAdaptiveCardPayload;
  threadId?: string;
}

export interface TeamsSdkAdaptiveCardUpdate {
  conversationId: string;
  messageId: string;
  card: TeamsAdaptiveCardPayload;
  threadId?: string;
}

export interface TeamsSdkClient {
  start(input: TeamsSdkStartInput): Promise<void>;
  stop(): Promise<void>;
  sendMessage(input: TeamsSdkOutboundMessage): Promise<TeamsSdkSendResult>;
  sendAdaptiveCard?(
    input: TeamsSdkAdaptiveCardMessage,
  ): Promise<TeamsSdkSendResult>;
  updateAdaptiveCard?(
    input: TeamsSdkAdaptiveCardUpdate,
  ): Promise<TeamsSdkSendResult>;
}

export interface TeamsChannelDependencies {
  sdkClient?: TeamsSdkClient;
  credentials?: TeamsChannelCredentials;
}

export type TeamsChannelOpts = Pick<
  ChannelOpts,
  'onMessage' | 'onChatMetadata' | 'isControlApproverAllowed'
>;

export interface PendingTeamsPermissionPrompt {
  conversationId: string;
  sourceAgentFolder: string;
  decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
  approvalContextJid?: string;
  request: PermissionApprovalRequest;
  threadId?: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: PermissionApprovalDecision) => void;
  settled: boolean;
}

export interface PendingTeamsUserQuestion {
  conversationId: string;
  sourceAgentFolder: string;
  request: UserQuestionRequest;
  threadId?: string;
  messageId?: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: UserQuestionResponse) => void;
  settled: boolean;
}

export function normalizeTeamsJid(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const conversationId = trimmed.startsWith(TEAMS_JID_PREFIX)
    ? trimmed.slice(TEAMS_JID_PREFIX.length).trim()
    : trimmed;
  return conversationId ? `${TEAMS_JID_PREFIX}${conversationId}` : null;
}

export function isTeamsJid(input: string): boolean {
  return teamsConversationIdFromJid(input) !== null;
}

export function teamsConversationIdFromJid(jid: string): string | null {
  const trimmed = jid.trim();
  if (!trimmed.startsWith(TEAMS_JID_PREFIX)) return null;
  const conversationId = trimmed.slice(TEAMS_JID_PREFIX.length).trim();
  return conversationId || null;
}

export function readTeamsCredentials(
  secrets?: RuntimeSecretProvider,
): TeamsChannelCredentials | null {
  if (!secrets) return null;
  const clientId =
    secrets.getOptionalSecret({ env: 'TEAMS_CLIENT_ID' })?.trim() || '';
  const clientSecret =
    secrets.getOptionalSecret({ env: 'TEAMS_CLIENT_SECRET' })?.trim() || '';
  const tenantId =
    secrets.getOptionalSecret({ env: 'TEAMS_TENANT_ID' })?.trim() || '';
  if (!clientId || !clientSecret || !tenantId) return null;
  const botAppId =
    secrets.getOptionalSecret({ env: 'TEAMS_BOT_APP_ID' })?.trim() || '';
  const botAppPassword =
    secrets.getOptionalSecret({ env: 'TEAMS_BOT_APP_PASSWORD' })?.trim() || '';
  const botTenantId =
    secrets.getOptionalSecret({ env: 'TEAMS_BOT_TENANT_ID' })?.trim() || '';
  return {
    clientId,
    clientSecret,
    tenantId,
    ...(botAppId ? { botAppId } : {}),
    ...(botAppPassword ? { botAppPassword } : {}),
    ...(botTenantId ? { botTenantId } : {}),
  };
}
