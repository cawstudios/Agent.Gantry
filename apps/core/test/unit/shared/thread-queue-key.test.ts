import { describe, expect, it } from 'vitest';

import {
  findConversationRouteForQueue,
  findConversationRoutesForChat,
  findSingleConversationRouteForChat,
  makeAgentThreadQueueKey,
  makeThreadQueueKey,
  parseAgentThreadQueueKey,
  parseThreadQueueKey,
} from '@core/shared/thread-queue-key.js';

describe('thread queue keys', () => {
  it('keeps thread-only parsing compatible when an agent is present', () => {
    const queueJid = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:triage',
      'thread:one',
    );

    expect(parseThreadQueueKey(queueJid)).toEqual({
      chatJid: 'sl:C123',
      threadId: 'thread:one',
    });
    expect(parseAgentThreadQueueKey(queueJid)).toEqual({
      chatJid: 'sl:C123',
      threadId: 'thread:one',
      agentId: 'agent:triage',
    });
  });

  it('parses old thread-only keys unchanged', () => {
    const queueJid = makeThreadQueueKey('sl:C123', 'thread:one');

    expect(parseAgentThreadQueueKey(queueJid)).toEqual({
      chatJid: 'sl:C123',
      threadId: 'thread:one',
    });
  });

  it('ignores malformed or empty agent key suffixes', () => {
    expect(parseAgentThreadQueueKey('sl:C123::agent:')).toEqual({
      chatJid: 'sl:C123',
    });
    expect(parseAgentThreadQueueKey('sl:C123::agent:%20%20')).toEqual({
      chatJid: 'sl:C123',
    });
    expect(parseAgentThreadQueueKey('sl:C123::agent:%E0%A4%A')).toEqual({
      chatJid: 'sl:C123',
    });
  });

  it('finds bare and agent-qualified routes for a provider conversation', () => {
    const routes = {
      'sl:C123': { folder: 'main' },
      [makeAgentThreadQueueKey('sl:C123', 'agent:triage')]: {
        folder: 'triage',
      },
      [makeAgentThreadQueueKey('sl:C123', 'agent:topic', '171.1')]: {
        folder: 'topic',
      },
      [makeAgentThreadQueueKey('sl:C999', 'agent:other')]: { folder: 'other' },
    };

    expect(
      findConversationRoutesForChat(routes, 'sl:C123').map(
        ([, route]) => route.folder,
      ),
    ).toEqual(['main', 'triage']);
    expect(
      findConversationRoutesForChat(routes, 'sl:C123', '171.1').map(
        ([, route]) => route.folder,
      ),
    ).toEqual(['topic']);
    expect(findSingleConversationRouteForChat(routes, 'sl:C123')).toBe(
      undefined,
    );
    expect(
      findSingleConversationRouteForChat(routes, 'sl:C123', '171.1'),
    ).toEqual({ folder: 'topic' });
    expect(findSingleConversationRouteForChat(routes, 'sl:C999')).toEqual({
      folder: 'other',
    });
  });

  it('does not let thread-scoped routes register a whole conversation', () => {
    const routes = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:topic', '171.1')]: {
        folder: 'topic',
      },
      [makeThreadQueueKey('sl:C123', '171.2')]: { folder: 'legacy-topic' },
    };

    expect(findConversationRoutesForChat(routes, 'sl:C123')).toEqual([]);
    expect(findSingleConversationRouteForChat(routes, 'sl:C123')).toBe(
      undefined,
    );
  });

  it('falls back to whole-conversation routes for threaded events without an exact route', () => {
    const routes = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:triage')]: {
        folder: 'triage',
      },
      [makeAgentThreadQueueKey('sl:C123', 'agent:topic', '171.1')]: {
        folder: 'topic',
      },
    };

    expect(findConversationRoutesForChat(routes, 'sl:C123', '171.2')).toEqual([
      [
        makeAgentThreadQueueKey('sl:C123', 'agent:triage'),
        { folder: 'triage' },
      ],
    ]);
  });

  it('selects route keys by chat, thread, and agent', () => {
    const wholeAlpha = { folder: 'alpha', name: 'whole' };
    const threadAlpha = { folder: 'alpha', name: 'thread' };
    const threadBeta = { folder: 'beta', name: 'beta-thread' };
    const routes = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha')]: wholeAlpha,
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1')]: threadAlpha,
      [makeAgentThreadQueueKey('sl:C123', 'agent:beta', 'T1')]: threadBeta,
    };
    const agentIdForRoute = (route: { folder: string }) =>
      `agent:${route.folder}`;

    expect(
      findConversationRouteForQueue(
        routes,
        makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1'),
        agentIdForRoute,
      ),
    ).toBe(threadAlpha);
    expect(
      findConversationRouteForQueue(
        routes,
        makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T2'),
        agentIdForRoute,
      ),
    ).toBe(wholeAlpha);
    expect(
      findConversationRouteForQueue(
        routes,
        makeAgentThreadQueueKey('sl:C123', 'agent:alpha'),
        agentIdForRoute,
      ),
    ).toBe(wholeAlpha);
  });

  it('does not select a thread route for a top-level queue', () => {
    const routes = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1')]: {
        folder: 'alpha',
      },
    };

    expect(
      findConversationRouteForQueue(
        routes,
        makeAgentThreadQueueKey('sl:C123', 'agent:alpha'),
        (route) => `agent:${route.folder}`,
      ),
    ).toBeUndefined();
  });

  it('prefers agent-qualified routes over legacy bare routes', () => {
    const legacy = { folder: 'alpha', name: 'legacy' };
    const qualified = { folder: 'alpha', name: 'qualified' };
    const routes = {
      'sl:C123': legacy,
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha')]: qualified,
    };

    expect(
      findConversationRouteForQueue(
        routes,
        makeAgentThreadQueueKey('sl:C123', 'agent:alpha'),
        (route) => `agent:${route.folder}`,
      ),
    ).toBe(qualified);
  });

  it('resolves duplicate bare and agent-qualified aliases for unqualified queues', () => {
    const legacy = { folder: 'alpha', name: 'legacy' };
    const qualified = { folder: 'alpha', name: 'qualified' };
    const routes = {
      'sl:C123': legacy,
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha')]: qualified,
    };

    expect(
      findConversationRouteForQueue(
        routes,
        'sl:C123',
        (route) => `agent:${route.folder}`,
      ),
    ).toBe(qualified);
  });
});
