import { describe, expect, it } from 'vitest';

import {
  findConversationRouteForQueue,
  findConversationRoutesForChat,
  findSingleConversationRouteForChat,
  makeAgentThreadQueueKey,
  makeThreadQueueKey,
  parseAgentThreadQueueKey,
  parseThreadQueueKey,
  routesForConversationId,
} from '@core/application/provider-conversations/thread-queue-key.js';

describe('thread queue keys', () => {
  it('scopes routes to one canonical conversation and fails closed without its id', () => {
    const shared = { conversationId: 'conversation:shared' };
    const other = { conversationId: 'conversation:other' };
    const routes = { shared, other };

    expect(routesForConversationId(routes, 'conversation:shared')).toEqual({
      shared,
    });
    expect(routesForConversationId(routes, undefined)).toEqual({});
  });

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

  it('keeps provider-account-qualified route keys addressable by chat and agent', () => {
    const queueJid = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:triage',
      'thread:one',
      'slack_one',
    );

    expect(parseThreadQueueKey(queueJid)).toEqual({
      chatJid: 'sl:C123',
      threadId: 'thread:one',
    });
    expect(parseAgentThreadQueueKey(queueJid)).toEqual({
      chatJid: 'sl:C123',
      threadId: 'thread:one',
      agentId: 'agent:triage',
      providerAccountId: 'slack_one',
    });
  });

  it('does not collapse same chat and agent routes across provider accounts', () => {
    const routes = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:triage', undefined, 'one')]: {
        folder: 'triage',
        providerAccountId: 'one',
      },
      [makeAgentThreadQueueKey('sl:C123', 'agent:triage', undefined, 'two')]: {
        folder: 'triage',
        providerAccountId: 'two',
      },
    };

    expect(
      findConversationRouteForQueue(
        routes,
        makeAgentThreadQueueKey('sl:C123', 'agent:triage'),
      ),
    ).toBeUndefined();
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

  it('finds agent-qualified routes for a provider conversation', () => {
    const routes = {
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
    ).toEqual(['triage']);
    expect(
      findConversationRoutesForChat(routes, 'sl:C123', '171.1').map(
        ([, route]) => route.folder,
      ),
    ).toEqual(['topic']);
    expect(findSingleConversationRouteForChat(routes, 'sl:C123')).toEqual({
      folder: 'triage',
    });
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
      [makeAgentThreadQueueKey('sl:C123', 'agent:other', '171.2')]: {
        folder: 'other',
      },
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

  it('filters chat routes by provider account', () => {
    const routes = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha', undefined, 'acct-a')]:
        {
          folder: 'alpha',
          providerAccountId: 'acct-a',
        },
      [makeAgentThreadQueueKey('sl:C123', 'agent:beta', undefined, 'acct-b')]: {
        folder: 'beta',
        providerAccountId: 'acct-b',
      },
    };

    expect(
      findConversationRoutesForChat(routes, 'sl:C123', null, 'acct-b'),
    ).toEqual([
      [
        makeAgentThreadQueueKey('sl:C123', 'agent:beta', undefined, 'acct-b'),
        { folder: 'beta', providerAccountId: 'acct-b' },
      ],
    ]);
    expect(
      findSingleConversationRouteForChat(routes, 'sl:C123', null, 'acct-b'),
    ).toEqual({ folder: 'beta', providerAccountId: 'acct-b' });
    expect(findSingleConversationRouteForChat(routes, 'sl:C123')).toBe(
      undefined,
    );

    const ambiguousAccountRoutes = {
      ...routes,
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:beta-backup',
        undefined,
        'acct-b',
      )]: {
        folder: 'beta-backup',
        providerAccountId: 'acct-b',
      },
    };
    expect(() =>
      findSingleConversationRouteForChat(
        ambiguousAccountRoutes,
        'sl:C123',
        null,
        'acct-b',
      ),
    ).toThrow(
      'Conversation route is ambiguous for sl:C123 under provider account acct-b',
    );
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
    expect(
      findConversationRouteForQueue(
        routes,
        makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1'),
      ),
    ).toBe(threadAlpha);
    expect(
      findConversationRouteForQueue(
        routes,
        makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T2'),
      ),
    ).toBe(wholeAlpha);
    expect(
      findConversationRouteForQueue(
        routes,
        makeAgentThreadQueueKey('sl:C123', 'agent:alpha'),
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
      ),
    ).toBeUndefined();
  });
});
