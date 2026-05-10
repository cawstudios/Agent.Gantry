import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '../conversation/conversation.js';

export type MemorySubject =
  | { kind: 'app'; appId: AppId }
  | { kind: 'agent'; appId: AppId; agentId: AgentId }
  | { kind: 'user'; appId: AppId; userId: UserId }
  | { kind: 'conversation'; appId: AppId; conversationId: ConversationId }
  | {
      kind: 'thread';
      appId: AppId;
      conversationId: ConversationId;
      threadId: ConversationThreadId;
    };
