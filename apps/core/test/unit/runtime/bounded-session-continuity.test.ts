import { describe, expect, it } from 'vitest';

import {
  boundSessionConversationContext,
  boundedSessionSummaryContextBlock,
  buildBoundedSessionSummary,
} from '@core/runtime/bounded-session-continuity.js';
import type { NewMessage } from '@core/domain/types.js';

function message(index: number): NewMessage {
  return {
    id: `message-${index}`,
    chat_jid: 'app:test:chat',
    sender: 'user',
    sender_name: 'User',
    content: `visible-${index}`,
    timestamp: `2026-07-20T00:00:${String(index).padStart(2, '0')}.000Z`,
    callerResolvedTools: {
      sessionId: 'session-1',
      tools: [
        {
          name: 'secret_tool',
          description: 'must not survive',
          inputSchema: { secret: 'tool-body' },
        },
      ],
      maxInteractions: 1,
      interactionTimeoutMs: 1_000,
    },
    providerData: { secret: 'provider-body' },
  };
}

describe('bounded session continuity', () => {
  it('keeps only eight visible historical messages and preserves the current turn', () => {
    const current = message(20);
    const result = boundSessionConversationContext({
      recentChannelContext: Array.from({ length: 12 }, (_, index) =>
        message(index),
      ),
      activeThreadContext: [],
      currentMessages: [current],
      metadata: {
        recentChannelCount: 12,
        activeThreadCount: 0,
        currentMessageCount: 1,
        activeThreadId: null,
        recentChannelWindowComplete: false,
        activeThreadWindowComplete: true,
        activeThreadRootPresent: true,
      },
    });

    expect(result.recentChannelContext).toHaveLength(8);
    expect(result.recentChannelContext[0]?.id).toBe('message-4');
    expect(result.recentChannelContext[0]).not.toHaveProperty(
      'callerResolvedTools',
    );
    expect(result.recentChannelContext[0]).not.toHaveProperty('providerData');
    expect(result.currentMessages[0]).toBe(current);
  });

  it('rolls accepted answers without accepting tool payload input', () => {
    const citation = 'evidence_search_chunk_701d788e6845';
    const summary = buildBoundedSessionSummary({
      previousSummary: 'Earlier answer',
      finalAnswer: `Latest <bounded> answer [${citation}]`,
    });

    expect(summary).toContain('Earlier answer');
    expect(summary).toContain(citation);
    expect(boundedSessionSummaryContextBlock({ summary })).toContain(
      '&lt;bounded',
    );
  });
});
