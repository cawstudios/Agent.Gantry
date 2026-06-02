import { describe, expect, it, vi } from 'vitest';

import {
  findInternalLeak,
  guardCustomerVisibleOutput,
  stripLeadingNarration,
} from '@core/application/customer-output/customer-safe-output.js';
import { CUSTOMER_VISIBLE_DECLINE_MESSAGE } from '@core/shared/user-visible-messages.js';

const CLEAN =
  'Your order #BSS-2847 is out for delivery and should arrive today.';
const LEAKY =
  'The MCP tool returned PRIVACY_GUARD_FAILED, so check the Shopify Admin panel.';

describe('guardCustomerVisibleOutput', () => {
  it('passes clean customer replies through unchanged', () => {
    expect(
      guardCustomerVisibleOutput({
        text: CLEAN,
        persona: 'sales',
        conversationJid: 'wa:917003705584',
      }),
    ).toBe(CLEAN);
  });

  it('replaces a reply that leaks internal detail and logs the hit', () => {
    const logger = { warn: vi.fn() };

    const result = guardCustomerVisibleOutput({
      text: LEAKY,
      persona: 'sales',
      conversationJid: 'wa:917003705584',
      logger,
    });

    expect(result).toBe(CUSTOMER_VISIBLE_DECLINE_MESSAGE);
    expect(result).not.toMatch(/mcp|privacy[ _-]?guard|shopify admin/i);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'wa:917003705584' }),
      expect.stringContaining('internal implementation detail'),
    );
  });

  it('does not redact developer-persona output', () => {
    expect(
      guardCustomerVisibleOutput({
        text: LEAKY,
        persona: 'developer',
        conversationJid: 'app:ops',
      }),
    ).toBe(LEAKY);
  });

  it('guards by default when persona is unset (fail-safe)', () => {
    expect(
      guardCustomerVisibleOutput({
        text: LEAKY,
        persona: undefined,
        conversationJid: 'wa:917003705584',
      }),
    ).toBe(CUSTOMER_VISIBLE_DECLINE_MESSAGE);
  });

  it('does not flag innocent words that are not internal markers', () => {
    expect(
      findInternalLeak('Can I get a gift hamper delivered tomorrow?'),
    ).toBeUndefined();
  });

  it('flags the added internal markers a customer reply must never contain', () => {
    expect(
      findInternalLeak('I pulled it from our Shopify integration.'),
    ).toBeDefined();
    expect(
      findInternalLeak("The knowledge base doesn't have prices filled in yet."),
    ).toBeDefined();
    expect(
      findInternalLeak('You can look it up in the admin dashboard.'),
    ).toBeDefined();
    expect(
      findInternalLeak("That's a privacy/security control on our side."),
    ).toBeDefined();
  });
});

describe('stripLeadingNarration', () => {
  it('trims a lookup-narration sentence glued to the answer', () => {
    expect(
      stripLeadingNarration(
        "I'll look up your order history now.Your last order is #109260.",
      ),
    ).toBe('Your last order is #109260.');
  });

  it('trims a "let me check" preamble before the answer', () => {
    expect(
      stripLeadingNarration('Let me check that for you. Your order shipped.'),
    ).toBe('Your order shipped.');
  });

  it('trims a "looking up … now" preamble', () => {
    expect(
      stripLeadingNarration(
        'Looking up the catalogue now.We have dark chocolate.',
      ),
    ).toBe('We have dark chocolate.');
  });

  it('leaves a clean answer untouched', () => {
    const clean = 'Your last order is #109260, delivered to Mumbai.';
    expect(stripLeadingNarration(clean)).toBe(clean);
  });

  it('leaves an empathy-led reply untouched', () => {
    const empathy =
      "I'm really sorry — that's not what we wanted for you. Let me sort this.";
    expect(stripLeadingNarration(empathy)).toBe(empathy);
  });

  it('does not trip on a handoff "let me get someone"', () => {
    const handoff = "Let me get someone for you now. They'll have everything.";
    expect(stripLeadingNarration(handoff)).toBe(handoff);
  });

  it('never blanks a reply that is only the narration sentence', () => {
    const onlyNarration = "I'll look up your order.";
    expect(stripLeadingNarration(onlyNarration)).toBe(onlyNarration);
  });

  it('trims a narration sentence that follows a short acknowledgment', () => {
    expect(
      stripLeadingNarration(
        'Sure! Let me pull that up right away.Order #109260 is delivered.',
      ),
    ).toBe('Sure! Order #109260 is delivered.');
  });

  it('trims a narration sentence after a "yes we do" opener', () => {
    expect(
      stripLeadingNarration(
        'Yes, we do! Let me pull up what we have.We have dark chocolate kaju katli.',
      ),
    ).toBe('Yes, we do! We have dark chocolate kaju katli.');
  });

  it('trims the lookup narration but KEEPS the empathy in a complaint reply', () => {
    expect(
      stripLeadingNarration(
        "I'm so sorry — that's genuinely not okay. Let me pull up your order. It shows delivered on 28 May.",
      ),
    ).toBe(
      "I'm so sorry — that's genuinely not okay. It shows delivered on 28 May.",
    );
  });

  it('does not trim a handoff that follows an acknowledgment', () => {
    const handoff = 'Sure! Let me check with the team and get back to you.';
    expect(stripLeadingNarration(handoff)).toBe(handoff);
  });

  it('trims a "searching … now" product-lookup preamble', () => {
    expect(
      stripLeadingNarration(
        'Searching for kaju katli now.We have dark chocolate kaju katli for ₹515.',
      ),
    ).toBe('We have dark chocolate kaju katli for ₹515.');
  });

  it('trims an "I\'ll search" preamble after an acknowledgment', () => {
    expect(
      stripLeadingNarration(
        "Yes! I'll search the catalogue for that.We have it in stock.",
      ),
    ).toBe('Yes! We have it in stock.');
  });

  it('trims a "let me look that up" preamble (object between verb and "up")', () => {
    expect(
      stripLeadingNarration(
        'Let me look that up for you.Your most recent order is #109260.',
      ),
    ).toBe('Your most recent order is #109260.');
  });

  it('trims an "I\'ll pull it up" preamble', () => {
    expect(
      stripLeadingNarration("I'll pull it up.Order #109260 shipped yesterday."),
    ).toBe('Order #109260 shipped yesterday.');
  });
});

describe('guardCustomerVisibleOutput narration trimming', () => {
  it('trims the narration preamble and logs it', () => {
    const logger = { warn: vi.fn() };
    const result = guardCustomerVisibleOutput({
      text: "I'll look up your order now.Your last order is #109260.",
      persona: 'sales',
      conversationJid: 'wa:917003705584',
      logger,
    });
    expect(result).toBe('Your last order is #109260.');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'wa:917003705584' }),
      expect.stringContaining('narration'),
    );
  });
});
