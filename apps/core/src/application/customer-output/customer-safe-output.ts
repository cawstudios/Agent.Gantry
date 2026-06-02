import type { AgentPersona } from '../../shared/agent-persona.js';
import { CUSTOMER_VISIBLE_DECLINE_MESSAGE } from '../../shared/user-visible-messages.js';

export interface CustomerOutputLogger {
  warn(meta: Record<string, unknown>, message: string): void;
}

// High-signal markers of internal implementation that must never reach an end
// customer. This is a deterministic backstop *behind* the agent's system prompt
// and the guardrail — not the primary control — so it is kept tight to avoid
// nuking innocent replies, and is fail-closed: on any match the whole reply is
// replaced rather than partially edited.
export const INTERNAL_LEAK_PATTERNS: readonly RegExp[] = [
  /\bmcp\b/i,
  /mcp__/,
  /\bx-caller-identity\b/i,
  /\bprivacy[ _-]?guard\b/i,
  /\bprivacy check\b/i,
  /\bsigned channel\b/i,
  /\bshopify (?:admin|api|integration)\b/i,
  /\badmin panel\b/i,
  /\badmin (?:tool|dashboard)\b/i,
  /\bknowledge base\b/i,
  /\bsecurity control\b/i,
  /\binternal lookup\b/i,
  /\berror code\b/i,
  /\bhttp\s+\d{3}\b/i,
  /\bstack\s?trace\b/i,
  /\b(?:PRIVACY_GUARD_FAILED|ACCESS_DENIED|SCOPE_MISSING|INVALID_CREDENTIALS|INTERNAL_ERROR|RATE_LIMITED|NOT_FOUND|INVALID_REQUEST)\b/,
];

export function findInternalLeak(text: string): string | undefined {
  return INTERNAL_LEAK_PATTERNS.find((pattern) => pattern.test(text))?.source;
}

// A leading "I'll look up… / let me check… / looking that up…" sentence is
// lookup preamble the customer should never see — a customer reply must lead
// with the answer, not narrate the fetch. Generic English narration only (no
// agent-specific phrasing); models tend to emit this before a tool call and it
// gets glued to the answer ("…now.Your order is…").
const LEADING_NARRATION_RE =
  /\b(?:i['’]?ll\s+(?:just\s+|quickly\s+)?(?:look(?:\s+(?:that|it|this))?\s*up|pull(?:\s+(?:that|it|this))?\s*up|check|fetch|grab|pull|search)|let me\s+(?:just\s+|quickly\s+)?(?:look(?:\s+(?:that|it|this))?\s*up|pull(?:\s+(?:that|it|this))?\s*up|check|fetch|grab|pull|search)|looking\s+(?:that\s+up|it\s+up|up\b)|searching\b|pulling\s+(?:that|this|it|your)[^.!?\n]*\bup\b|fetching\b|one moment\b|on it\b)/i;

// A lookup-narration sentence is not always the FIRST sentence: models often emit
// a one-word acknowledgment or a line of empathy first ("Sure! Let me pull that
// up. …" / "I'm so sorry. Let me pull up your order. …"). A handoff line ("let me
// check with the team") must be preserved. So scan the first few sentences, remove
// the FIRST that is pure lookup-narration (and not a handoff), and keep everything
// else — acknowledgment, empathy, the answer — with its original formatting.
const NARRATION_HANDOFF_RE =
  /\b(?:team|someone|colleague|a human|connect|specialist|reach out|get back to you)\b/i;

// Conservative by design: only the first few sentences are scanned (a verb deep in
// a long answer is never touched), only a clear lookup-narration sentence is cut,
// handoffs are spared, and it never removes a sentence that leaves nothing after it
// — so it cannot blank a reply or clip a genuine answer.
export function stripLeadingNarration(text: string): string {
  const sentenceRe = /[^.!?\n]*[.!?]+/g;
  let match: RegExpExecArray | null;
  let scanned = 0;
  while ((match = sentenceRe.exec(text)) !== null && scanned < 3) {
    scanned += 1;
    const sentence = match[0];
    if (
      !LEADING_NARRATION_RE.test(sentence) ||
      NARRATION_HANDOFF_RE.test(sentence)
    ) {
      continue;
    }
    const before = text.slice(0, match.index).replace(/\s+$/, '');
    const after = text.slice(match.index + sentence.length).replace(/^\s+/, '');
    if (!after) return text; // nothing of substance would remain — leave it alone
    return before ? `${before} ${after}` : after;
  }
  return text;
}

// Guards a customer-facing outbound message. Developer-persona agents are
// allowed to surface implementation detail; every other persona — including an
// agent with no explicit persona — is treated as customer-facing and gets the
// fail-closed redaction. Replacing the whole message (rather than asking an LLM
// to rewrite it) keeps the backstop deterministic and incapable of re-leaking;
// a hit is logged so the underlying prompt can be fixed.
export function guardCustomerVisibleOutput(input: {
  text: string;
  persona: AgentPersona | undefined;
  conversationJid: string;
  logger?: CustomerOutputLogger;
}): string {
  if (input.persona === 'developer') return input.text;
  const matchedPattern = findInternalLeak(input.text);
  if (matchedPattern) {
    input.logger?.warn(
      { conversationJid: input.conversationJid, matchedPattern },
      'Customer-visible output guard replaced a reply that leaked internal implementation detail',
    );
    return CUSTOMER_VISIBLE_DECLINE_MESSAGE;
  }
  const trimmed = stripLeadingNarration(input.text);
  if (trimmed !== input.text) {
    input.logger?.warn(
      { conversationJid: input.conversationJid },
      'Customer-visible output guard trimmed a leading lookup-narration preamble from a reply',
    );
  }
  return trimmed;
}
