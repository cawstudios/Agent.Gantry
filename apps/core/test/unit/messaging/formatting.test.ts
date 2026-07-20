import { describe, it, expect } from 'vitest';

import {
  ASSISTANT_NAME,
  getTriggerPattern,
  TRIGGER_PATTERN,
} from '@core/config/index.js';
import {
  CONVERSATION_CONTEXT_RENDER_LIMITS,
  escapeXml,
  findChannel,
  formatConversationContextMessages,
  formatMessages,
  stripInternalTags,
} from '@core/messaging/router.js';
import { Channel, NewMessage } from '@core/domain/types.js';
import {
  renderSlackText,
  renderTelegramText,
} from '@core/channels/text-rendering.js';
import {
  canonicalTailAfterRenderedPrefix,
  planCanonicalMarkdownDeliveryChunks,
} from '@core/channels/canonical-markdown-delivery.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'grp:1',
    sender: 'user:alice',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('canonical Markdown delivery planning', () => {
  it('preserves a link destination when wrapper overhead exceeds the limit', () => {
    const destination = `https://example.test/${'a'.repeat(60)}`;
    const chunks = planCanonicalMarkdownDeliveryChunks({
      canonicalText: `[download](${destination})`,
      maxRenderedCodeUnits: 20,
      render: renderSlackText,
    });

    expect(chunks.every((chunk) => chunk.renderedText.length <= 20)).toBe(true);
    expect(chunks.map((chunk) => chunk.canonicalText).join('')).toBe(
      `download\n${destination}`,
    );
  });

  it('maps a rendered plain-text prefix back to its canonical tail', () => {
    expect(
      canonicalTailAfterRenderedPrefix({
        canonicalText: `${'x'.repeat(12000)}**retry me**`,
        renderedPrefix: 'x'.repeat(12000),
        render: renderSlackText,
      }),
    ).toBe('**retry me**');
  });

  it('maps a complete formatted prefix without assuming monotonic rendering', () => {
    expect(
      canonicalTailAfterRenderedPrefix({
        canonicalText: '**a**x',
        renderedPrefix: '*a*',
        render: renderSlackText,
      }),
    ).toBe('x');
  });

  it('maps many formatted tokens with linear rendering work', () => {
    const tokens = Array.from({ length: 200 }, (_, index) => `**${index}**`);
    const canonicalText = `${tokens.join('')}tail`;
    const renderedPrefix = renderSlackText(tokens.join(''));
    let renderedCodeUnits = 0;

    expect(
      canonicalTailAfterRenderedPrefix({
        canonicalText,
        renderedPrefix,
        render: (text) => {
          renderedCodeUnits += text.length;
          return renderSlackText(text);
        },
      }),
    ).toBe('tail');
    expect(renderedCodeUnits).toBeLessThan(canonicalText.length * 3);
  });
});

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles multiple special characters together', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('passes through strings with no special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  const TZ = 'UTC';

  it('formats a single message as XML with context header', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<message sender="Alice"');
    expect(result).toContain('>hello</message>');
    expect(result).toContain('Jan 1, 2024');
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender_name: 'Alice',
        content: 'hi',
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
      makeMsg({
        id: '2',
        sender_name: 'Bob',
        content: 'hey',
        timestamp: '2024-01-01T01:00:00.000Z',
      }),
    ];
    const result = formatMessages(msgs, TZ);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('>hi</message>');
    expect(result).toContain('>hey</message>');
  });

  it('escapes special characters in sender names', () => {
    const result = formatMessages([makeMsg({ sender_name: 'A & B <Co>' })], TZ);
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
  });

  it('escapes special characters in content', () => {
    const result = formatMessages(
      [makeMsg({ content: '<script>alert("xss")</script>' })],
      TZ,
    );
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('handles empty array', () => {
    const result = formatMessages([], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<messages>\n\n</messages>');
  });

  it('renders reply context as quoted_message element', () => {
    const result = formatMessages(
      [
        makeMsg({
          content: 'Yes, on my way!',
          reply_to_message_id: '42',
          reply_to_message_content: 'Are you coming tonight?',
          reply_to_sender_name: 'Bob',
        }),
      ],
      TZ,
    );
    expect(result).toContain('reply_to="42"');
    expect(result).toContain(
      '<quoted_message from="Bob">Are you coming tonight?</quoted_message>',
    );
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('omits reply attributes when no reply context', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('omits quoted_message when content is missing but id is present', () => {
    const result = formatMessages(
      [
        makeMsg({
          reply_to_message_id: '42',
          reply_to_sender_name: 'Bob',
        }),
      ],
      TZ,
    );
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('escapes special characters in reply context', () => {
    const result = formatMessages(
      [
        makeMsg({
          reply_to_message_id: '1',
          reply_to_message_content: '<script>alert("xss")</script>',
          reply_to_sender_name: 'A & B',
        }),
      ],
      TZ,
    );
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('converts timestamps to local time for given timezone', () => {
    // 2024-01-01T18:30:00Z in America/New_York (EST) = 1:30 PM
    const result = formatMessages(
      [makeMsg({ timestamp: '2024-01-01T18:30:00.000Z' })],
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('<context timezone="America/New_York" />');
  });
});

describe('formatConversationContextMessages', () => {
  const TZ = 'UTC';

  it('renders recent channel, active thread, then current message with current_message last', () => {
    const result = formatConversationContextMessages(
      {
        recentChannelContext: [
          makeMsg({ id: 'recent', content: 'channel decision' }),
        ],
        activeThreadContext: [
          makeMsg({
            id: 'thread',
            content: 'thread detail',
            thread_id: 'thread-1',
          }),
        ],
        currentMessages: [
          makeMsg({ id: 'current', content: '@Gantry summarize' }),
        ],
        metadata: {
          recentChannelCount: 1,
          activeThreadCount: 1,
          currentMessageCount: 1,
          activeThreadId: 'thread-1',
        },
      },
      TZ,
    );

    const recentIndex = result.indexOf('<recent_channel_context');
    const threadIndex = result.indexOf('<active_thread_context');
    const currentIndex = result.indexOf('<current_message');

    expect(result).toContain('<context timezone="UTC" />');
    expect(recentIndex).toBeGreaterThan(-1);
    expect(threadIndex).toBeGreaterThan(recentIndex);
    expect(currentIndex).toBeGreaterThan(threadIndex);
    expect(result.trim().endsWith('</current_message>')).toBe(true);
  });

  it('escapes XML in all conversation context sections', () => {
    const result = formatConversationContextMessages(
      {
        recentChannelContext: [
          makeMsg({
            id: 'recent',
            sender_name: 'A & B',
            content: '<channel "data">',
          }),
        ],
        activeThreadContext: [
          makeMsg({
            id: 'thread',
            sender_name: 'Root <Owner>',
            content: 'thread & reply',
            reply_to_message_id: 'root<&>',
            reply_to_message_content: 'quoted <root>',
            reply_to_sender_name: 'Q & A',
          }),
        ],
        currentMessages: [
          makeMsg({
            id: 'current',
            sender_name: 'Current "User"',
            content: '@Gantry use <this> & that',
          }),
        ],
        metadata: {
          recentChannelCount: 1,
          activeThreadCount: 1,
          currentMessageCount: 1,
          activeThreadId: 'thread-1',
        },
      },
      TZ,
    );

    expect(result).toContain('sender="A &amp; B"');
    expect(result).toContain('&lt;channel &quot;data&quot;&gt;');
    expect(result).toContain('sender="Root &lt;Owner&gt;"');
    expect(result).toContain('reply_to="root&lt;&amp;&gt;"');
    expect(result).toContain(
      '<quoted_message from="Q &amp; A">quoted &lt;root&gt;</quoted_message>',
    );
    expect(result).toContain('sender="Current &quot;User&quot;"');
    expect(result).toContain('@Gantry use &lt;this&gt; &amp; that');
  });

  it('renders escaped attachment descriptors without provider ids and keeps current_message last', () => {
    const result = formatConversationContextMessages(
      {
        recentChannelContext: [
          makeMsg({ id: 'recent', content: 'channel context' }),
        ],
        activeThreadContext: [
          makeMsg({ id: 'thread', content: 'thread context' }),
        ],
        currentMessages: [
          makeMsg({
            id: 'current',
            content: '',
            attachments: [
              {
                kind: 'image',
                contentType: 'image/svg+xml; name="<diagram&1>"',
                sizeBytes: 2048,
                externalId: 'provider-file-123',
                storageRef: 'attachments/diagram & <1>.svg',
              },
            ],
          }),
        ],
      },
      TZ,
    );

    expect(result).toContain(
      '<attachment kind="image" content_type="image/svg+xml; name=&quot;&lt;diagram&amp;1&gt;&quot;" size_bytes="2048" gantry_ref="attachments/diagram &amp; &lt;1&gt;.svg" />',
    );
    expect(result).not.toContain('externalId');
    expect(result).not.toContain('provider-file-123');
    expect(result.trim().endsWith('</current_message>')).toBe(true);
  });

  it('truncates long historical message content and quoted content after XML escaping remains safe', () => {
    const result = formatConversationContextMessages(
      {
        recentChannelContext: [
          makeMsg({
            id: 'recent',
            content: `${'<content>'.repeat(
              CONVERSATION_CONTEXT_RENDER_LIMITS.messageContentBytes,
            )}CONTENT_TAIL`,
            reply_to_message_id: 'root',
            reply_to_sender_name: 'Root',
            reply_to_message_content: `${'<quote>'.repeat(
              CONVERSATION_CONTEXT_RENDER_LIMITS.quotedMessageContentBytes,
            )}QUOTE_TAIL`,
          }),
        ],
        activeThreadContext: [],
        currentMessages: [
          makeMsg({
            id: 'current',
            content: '@Gantry use this instruction',
          }),
        ],
      },
      TZ,
    );

    expect(result).toContain('...[truncated]');
    expect(result).not.toContain('CONTENT_TAIL');
    expect(result).not.toContain('QUOTE_TAIL');
    expect(result).not.toContain('<content>');
    expect(result).not.toContain('<quote>');
    expect(result).toContain('&lt;content&gt;');
    expect(result).toContain('&lt;quote&gt;');
    expect(result.trim().endsWith('</current_message>')).toBe(true);
  });

  it('preserves full current-turn message content', () => {
    const result = formatConversationContextMessages(
      {
        recentChannelContext: [],
        activeThreadContext: [],
        currentMessages: [
          makeMsg({
            id: 'current',
            content: `CURRENT ${'y'.repeat(
              CONVERSATION_CONTEXT_RENDER_LIMITS.messageContentBytes * 2,
            )} CURRENT_TAIL`,
          }),
        ],
      },
      TZ,
    );

    expect(result).toContain('CURRENT_TAIL');
    expect(result.trim().endsWith('</current_message>')).toBe(true);
  });

  it('caps total rendered context while preserving current_message as the final section', () => {
    const recentChannelContext = Array.from({ length: 80 }, (_, index) =>
      makeMsg({
        id: `recent-${index}`,
        content: `recent-${index} ${'x'.repeat(1200)}`,
      }),
    );

    const result = formatConversationContextMessages(
      {
        recentChannelContext,
        activeThreadContext: [],
        currentMessages: [
          makeMsg({ id: 'current', content: '@Gantry use this instruction' }),
        ],
      },
      TZ,
    );

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(
      CONVERSATION_CONTEXT_RENDER_LIMITS.renderedContextBytes,
    );
    expect(result).not.toContain('recent-0 ');
    expect(result).toContain('@Gantry use this instruction');
    expect(result.trim().endsWith('</current_message>')).toBe(true);
  });

  it('drops historical context but does not drop current-turn messages for the context budget', () => {
    const recentChannelContext = Array.from({ length: 80 }, (_, index) =>
      makeMsg({
        id: `recent-${index}`,
        content: `recent-${index} ${'x'.repeat(1200)}`,
      }),
    );
    const currentMessages = Array.from({ length: 8 }, (_, index) =>
      makeMsg({
        id: `current-${index}`,
        content: `CURRENT_${index} ${'y'.repeat(5000)} TAIL_${index}`,
        timestamp: `2024-01-01T00:${String(index).padStart(2, '0')}:00.000Z`,
      }),
    );

    const result = formatConversationContextMessages(
      {
        recentChannelContext,
        activeThreadContext: [],
        currentMessages,
      },
      TZ,
    );

    expect(result).not.toContain('recent-0 ');
    for (const message of currentMessages) {
      expect(result).toContain(message.id.replace('current-', 'CURRENT_'));
      expect(result).toContain(message.id.replace('current-', 'TAIL_'));
    }
    expect(result.trim().endsWith('</current_message>')).toBe(true);
  });
});

// --- TRIGGER_PATTERN ---

describe('TRIGGER_PATTERN', () => {
  const name = ASSISTANT_NAME;
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();

  it('matches @name at start of message', () => {
    expect(TRIGGER_PATTERN.test(`@${name} hello`)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(TRIGGER_PATTERN.test(`@${lower} hello`)).toBe(true);
    expect(TRIGGER_PATTERN.test(`@${upper} hello`)).toBe(true);
  });

  it('does not match when not at start of message', () => {
    expect(TRIGGER_PATTERN.test(`hello @${name}`)).toBe(false);
  });

  it('does not match partial name like @NameExtra (word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}extra hello`)).toBe(false);
  });

  it('matches with word boundary before apostrophe', () => {
    expect(TRIGGER_PATTERN.test(`@${name}'s thing`)).toBe(true);
  });

  it('matches @name alone (end of string is a word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}`)).toBe(true);
  });

  it('matches with leading whitespace after trim', () => {
    // The actual usage trims before testing: TRIGGER_PATTERN.test(m.content.trim())
    expect(TRIGGER_PATTERN.test(`@${name} hey`.trim())).toBe(true);
  });
});

describe('getTriggerPattern', () => {
  it('uses the configured per-group trigger when provided', () => {
    const pattern = getTriggerPattern('@Gantry');

    expect(pattern.test('@Gantry hello')).toBe(true);
    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(false);
  });

  it('falls back to the default trigger when group trigger is missing', () => {
    const pattern = getTriggerPattern(undefined);

    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(true);
  });

  it('treats regex characters in custom triggers literally', () => {
    const pattern = getTriggerPattern('@C.L.A.U.D.E');

    expect(pattern.test('@C.L.A.U.D.E hello')).toBe(true);
    expect(pattern.test('@CXLXAUXDXE hello')).toBe(false);
  });

  it('matches Slack mention triggers after leading words', () => {
    const pattern = getTriggerPattern('<@U0B70C5GFUH');

    expect(pattern.test('hey <@U0B70C5GFUH> hello')).toBe(true);
    expect(pattern.test('<@U0B70C5GFUH> hello')).toBe(true);
    expect(pattern.test('hey @ReAgent hello')).toBe(false);
  });

  it('keeps non-Slack triggers anchored to the start', () => {
    const pattern = getTriggerPattern('@ReAgent');

    expect(pattern.test('@ReAgent hello')).toBe(true);
    expect(pattern.test('hey @ReAgent hello')).toBe(false);
  });
});

// --- Outbound formatting (internal tag stripping + prefix) ---

describe('stripInternalTags', () => {
  it('strips single-line internal tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multi-line internal tags', () => {
    expect(
      stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world'),
    ).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(
      stripInternalTags('<internal>a</internal>hello<internal>b</internal>'),
    ).toBe('hello');
  });

  it('returns empty string when text is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });
});

describe('channel adapter text rendering — bold and italic', () => {
  it('converts **bold** to Telegram bold', () => {
    expect(renderTelegramText('**hello**')).toBe('*hello*');
  });

  it('converts **bold** with surrounding text', () => {
    expect(renderTelegramText('say **this** now')).toBe('say *this* now');
  });

  it('converts **bold** to Slack bold', () => {
    expect(renderSlackText('**hello**')).toBe('*hello*');
  });

  it('converts *italic* to Telegram italic', () => {
    expect(renderTelegramText('*italic*')).toBe('_italic_');
  });

  it('preserves ordering: **bold** *italic* -> *bold* _italic_', () => {
    expect(renderTelegramText('**bold** *italic*')).toBe('*bold* _italic_');
  });

  it('does not convert lone stars', () => {
    expect(renderTelegramText('a * b * c')).toBe('a * b * c');
  });
});

describe('channel adapter text rendering — headings and links', () => {
  it('converts markdown headings to bold markers', () => {
    expect(renderTelegramText('## Hello World')).toBe('*Hello World*');
    expect(renderTelegramText('### Section')).toBe('*Section*');
  });

  it('only converts headings at line start', () => {
    const input = 'not a ## heading in middle';
    expect(renderTelegramText(input)).toBe(input);
  });

  it('keeps Markdown links for Telegram MarkdownV2', () => {
    expect(renderTelegramText('[Link](https://example.com)')).toBe(
      '[Link](https://example.com)',
    );
  });

  it('converts links to Slack mrkdwn syntax', () => {
    expect(renderSlackText('[Click here](https://example.com)')).toBe(
      '<https://example.com|Click here>',
    );
  });
});

describe('channel adapter text rendering — code and horizontal rules', () => {
  it('does not transform content inside code spans', () => {
    expect(renderTelegramText('**bold** and `*code*`')).toBe(
      '*bold* and `*code*`',
    );
  });

  it('does not transform markers inside fenced code blocks', () => {
    const input = '```\n**not bold**\n```';
    expect(renderTelegramText(input)).toBe(input);
  });

  it('transforms text outside fenced blocks but keeps block content raw', () => {
    const input = '**bold**\n```\n**raw**\n```\n*italic*';
    expect(renderTelegramText(input)).toBe(
      '*bold*\n```\n**raw**\n```\n_italic_',
    );
  });

  it('strips markdown horizontal rules', () => {
    expect(renderTelegramText('above\n---\nbelow')).toBe('above\n\nbelow');
    expect(renderTelegramText('above\n***\nbelow')).toBe('above\n\nbelow');
  });
});

// --- Trigger gating with requiresTrigger flag ---

describe('trigger gating (requiresTrigger interaction)', () => {
  // Replicates the exact logic from processGroupMessages and startMessageLoop.
  function shouldRequireTrigger(requiresTrigger: boolean | undefined): boolean {
    return requiresTrigger !== false;
  }

  function shouldProcess(
    requiresTrigger: boolean | undefined,
    trigger: string | undefined,
    messages: NewMessage[],
  ): boolean {
    if (!shouldRequireTrigger(requiresTrigger)) return true;
    const triggerPattern = getTriggerPattern(trigger);
    return messages.some((m) => triggerPattern.test(m.content.trim()));
  }

  it('requires trigger when requiresTrigger is undefined', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(undefined, undefined, msgs)).toBe(false);
  });

  it('requires trigger when requiresTrigger=true', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, undefined, msgs)).toBe(false);
  });

  it('requiresTrigger=undefined defaults to trigger-required', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(undefined, undefined, msgs)).toBe(false);
  });

  it('requiresTrigger=true requires trigger', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, undefined, msgs)).toBe(false);
  });

  it('requiresTrigger=true processes when trigger present', () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(true, undefined, msgs)).toBe(true);
  });

  it('uses its per-conversation trigger instead of the default trigger', () => {
    const msgs = [makeMsg({ content: '@Gantry do something' })];
    expect(shouldProcess(true, '@Gantry', msgs)).toBe(true);
  });

  it('does not process when only the default trigger is present for a custom-trigger conversation', () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(true, '@Gantry', msgs)).toBe(false);
  });

  it('requiresTrigger=false always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, undefined, msgs)).toBe(true);
  });
});

// --- findChannel (line 48 coverage) ---

describe('findChannel', () => {
  function makeFakeChannel(name: string, ownedJids: string[]): Channel {
    return {
      name,
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: (jid: string) => ownedJids.includes(jid),
      disconnect: async () => {},
    };
  }

  it('returns the channel that owns the given JID', () => {
    const first = makeFakeChannel('first', ['grp:1', 'dm:1']);
    const second = makeFakeChannel('second', ['room:2']);

    expect(findChannel([first, second], 'grp:1')).toBe(first);
    expect(findChannel([first, second], 'room:2')).toBe(second);
  });

  it('returns undefined when no channel owns the JID', () => {
    const first = makeFakeChannel('first', ['grp:1']);
    expect(findChannel([first], 'unknown-jid')).toBeUndefined();
  });

  it('returns undefined for an empty channels array', () => {
    expect(findChannel([], 'grp:1')).toBeUndefined();
  });
});
