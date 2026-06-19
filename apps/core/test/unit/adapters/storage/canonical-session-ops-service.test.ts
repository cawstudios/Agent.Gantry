import { describe, expect, it, vi } from 'vitest';

import { CanonicalSessionOpsService } from '@core/adapters/storage/postgres/services/canonical-session-ops-service.js';
import type { AgentSessionDigest } from '@core/domain/sessions/sessions.js';

const SESSION = {
  id: 'session_1',
  appId: 'default',
  agentId: 'agent:boondi_support',
  conversationId: 'conversation:wa:000299180577',
  userId: '000299180577',
  status: 'active',
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
};

function sessionDigest(): AgentSessionDigest {
  return {
    id: 'digest_1' as never,
    appId: 'default' as never,
    agentSessionId: 'session_1' as never,
    trigger: 'session-end',
    digest: 'Customer discussed birthday boxes.',
    messageCount: 4,
    extractedFactCount: 0,
    metadata: {
      sessionScope: {
        appId: 'default',
        agentId: 'agent:boondi_support',
        conversationId: 'conversation:wa:000299180577',
        userId: '000299180577',
        threadId: null,
        jobId: null,
      },
    },
    createdAt: '2026-06-20T00:01:00.000Z' as never,
  };
}

function makeService(digests: AgentSessionDigest[]) {
  const canonicalRepository = {
    getAgentTurnContext: vi.fn(async () => ({
      appId: 'default',
      agentId: 'agent:boondi_support',
      agentSessionId: 'session_1',
      agentSessionResetAt: null,
    })),
  };
  const agentSessions = {
    getAgentSession: vi.fn(async () => SESSION),
  };
  const agentSessionDigests = {
    listAgentSessionDigests: vi.fn(async () => digests),
  };
  return new CanonicalSessionOpsService(
    canonicalRepository as never,
    {
      agentSessions: agentSessions as never,
      agentSessionDigests: agentSessionDigests as never,
    },
    { maxMemoryContextChars: 12_000 },
  );
}

describe('CanonicalSessionOpsService.getAgentTurnContext', () => {
  it('marks turn context when at least one recent session digest exists', async () => {
    const context = await makeService([sessionDigest()]).getAgentTurnContext({
      groupFolder: 'boondi_support',
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      chatJid: 'wa:000299180577',
      conversationKind: 'dm',
      memoryUserId: '000299180577',
    });

    expect(context.hasRecentSessionDigest).toBe(true);
    expect(context.memoryContextBlock).toContain('recent_session_digests');
  });

  it('marks turn context false when no recent session digest exists', async () => {
    const context = await makeService([]).getAgentTurnContext({
      groupFolder: 'boondi_support',
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      chatJid: 'wa:000299180577',
      conversationKind: 'dm',
      memoryUserId: '000299180577',
    });

    expect(context.hasRecentSessionDigest).toBe(false);
  });
});
