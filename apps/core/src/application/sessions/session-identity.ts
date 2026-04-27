import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '../../domain/conversation/conversation.js';
import type { JobId } from '../../domain/jobs/jobs.js';
import type { AgentSessionId } from '../../domain/sessions/sessions.js';

export interface AgentSessionKeyInput {
  appId: AppId;
  agentId: AgentId;
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  userId?: UserId;
  jobId?: JobId;
}

export function resolveAgentSessionKey(input: AgentSessionKeyInput): string {
  return [
    `app=${input.appId}`,
    `agent=${input.agentId}`,
    `conversation=${input.conversationId ?? ''}`,
    `thread=${input.threadId ?? ''}`,
    `user=${input.userId ?? ''}`,
    `job=${input.jobId ?? ''}`,
  ].join('|');
}

export function deterministicAgentSessionId(
  input: AgentSessionKeyInput,
): AgentSessionId {
  return `agent-session:${stableDigest(resolveAgentSessionKey(input))}` as AgentSessionId;
}

function stableDigest(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x85ebca6b;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0xc2b2ae35) >>> 0;
  }
  return `${first.toString(36)}${second.toString(36)}`;
}
