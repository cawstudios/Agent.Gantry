// Heuristic transcript classifier for the durable backstop.
//
// WHY HEURISTIC (not an LLM): boondi-crm runs as a standalone connector with no
// model access — Gantry reaches models through its internal OneCLI gateway, which
// is not reusable from a separate process without coupling boondi-crm to Gantry
// internals (that would break the clean-separation rule). So the backstop uses a
// deterministic, dependency-free classifier instead.
//
// WHAT IT IS FOR: the fast path (the live agent, which DOES have model access)
// does the precise capture + scoring. This backstop only has to guarantee that a
// business signal is NEVER LOST when the fast path didn't run (connector was down
// or errored). It therefore reconstructs a conservative QUERY — never a scored
// lead — from the durable transcript and flags it for a human to qualify. Being
// deterministic it is also free and never flaky.
//
// If an operator ever provides real model access, an LLM classifier can be slotted
// in behind the same `classifyTranscript` signature without touching the loop.

import type { IntentCategory, RecordInput } from '../db/types.js';

export interface TranscriptMessage {
  role: 'customer' | 'assistant';
  text: string;
}

export interface ClassifyResult {
  input: RecordInput;
  // The single customer line that best evidences the signal (for the human).
  trigger: string;
}

// Commercial-intent vocabulary (English + common Hindi/Hinglish), mirroring the
// cues Boondi already uses. Presence of any of these in a CUSTOMER line is a
// business signal worth a human follow-up.
const PRODUCT_WORDS =
  /\b(?:mithai|sweet|sweets|kaju|katli|barfi|burfi|ladoo|laddoo|bhujia|namkeen|chocolate|chocolates|hamper|hampers|gift\s?box|gift\s?boxes|box|boxes)\b/i;
const GIFTING_WORDS =
  /\b(?:gift|gifts|gifting|hamper|hampers|present|presents|favour|favor|return\s?gift)\b/i;
const ORDER_WORDS =
  /\b(?:order|buy|purchase|want|need|looking for|interested in|price|quote|bulk|kitna|daam|chahiye|chahie)\b/i;
const B2B_WORDS =
  /\b(?:corporate|office|company|employees?|staff|team|client|clients|vendor|vendors|business|b2b|procurement|wedding|shaadi|event)\b/i;

const OCCASIONS: Array<[RegExp, string]> = [
  [/\bdiwali|deepavali\b/i, 'Diwali'],
  [/\bwedding|shaadi|shadi\b/i, 'Wedding'],
  [/\braksha\s?bandhan|rakhi\b/i, 'Raksha Bandhan'],
  [/\bholi\b/i, 'Holi'],
  [/\beid\b/i, 'Eid'],
  [/\bnew\s?year\b/i, 'New Year'],
  [/\banniversary\b/i, 'Anniversary'],
  [/\bbirthday\b/i, 'Birthday'],
  [/\bcorporate\b/i, 'Corporate'],
];

function detectOccasion(text: string): string | undefined {
  for (const [pattern, label] of OCCASIONS) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

// A quantity worth recording: a number adjacent to a unit word. Avoids grabbing
// stray numbers (e.g. a phone number) by requiring the unit.
function detectQuantity(
  text: string,
): { quantity: number; raw: string } | undefined {
  const match = text.match(
    /(\d{1,3}(?:,\d{2,3})*|\d+)\s*(?:\+\s*)?(?:boxes|box|pieces|pcs|gifts|hampers|units|people|employees|staff|members|guests)/i,
  );
  if (!match) return undefined;
  const quantity = Number.parseInt(match[1]!.replace(/,/g, ''), 10);
  if (!Number.isFinite(quantity) || quantity <= 0) return undefined;
  return { quantity, raw: match[0]!.trim() };
}

// A budget amount: a rupee figure, optionally per-gift ("₹500 a box") vs total.
function detectBudget(
  text: string,
): { perGift?: number; total?: number; raw: string } | undefined {
  const match = text.match(
    /(?:₹|rs\.?|inr|rupees?)\s*(\d{1,3}(?:,\d{2,3})*|\d+)(?:\s*(k|lakh|lac))?|(\d{3,}(?:,\d{2,3})*)\s*(?:per|a|each|\/)\s*(?:box|gift|piece|hamper)/i,
  );
  if (!match) return undefined;
  const digits = (match[1] ?? match[3] ?? '').replace(/,/g, '');
  let amount = Number.parseInt(digits, 10);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = (match[2] ?? '').toLowerCase();
  if (unit === 'k') amount *= 1_000;
  else if (unit === 'lakh' || unit === 'lac') amount *= 100_000;
  // Heuristic: a per-unit phrase ("per box") or a smallish figure is per-gift;
  // a large figure with no per-unit phrase is treated as a total.
  const perUnit = /(?:per|a|each|\/)\s*(?:box|gift|piece|hamper)/i.test(match[0]!);
  if (perUnit || amount <= 5_000) return { perGift: amount, raw: match[0]!.trim() };
  return { total: amount, raw: match[0]!.trim() };
}

function detectIntent(text: string): IntentCategory {
  const b2b = B2B_WORDS.test(text);
  const gifting = GIFTING_WORDS.test(text);
  if (b2b && gifting) return 'corporate';
  if (b2b) return 'corporate';
  if (gifting) return 'gifting_personal';
  if (/\b(again|same as last|reorder|repeat)\b/i.test(text)) return 'reorder';
  if (ORDER_WORDS.test(text) || PRODUCT_WORDS.test(text)) return 'shopping';
  return 'other';
}

function hasBusinessSignal(text: string): boolean {
  return (
    GIFTING_WORDS.test(text) ||
    (ORDER_WORDS.test(text) && PRODUCT_WORDS.test(text)) ||
    (B2B_WORDS.test(text) && PRODUCT_WORDS.test(text)) ||
    (PRODUCT_WORDS.test(text) && /\b\d+\b/.test(text))
  );
}

// Classify a conversation transcript. Returns a conservative QUERY RecordInput
// when the customer showed commercial intent the fast path didn't capture, or
// null when there is no signal. Never returns a scored lead — qualification +
// scoring is left to a human / the live agent's next turn.
export function classifyTranscript(
  messages: readonly TranscriptMessage[],
): ClassifyResult | null {
  const customerLines = messages
    .filter((m) => m.role === 'customer')
    .map((m) => m.text.trim())
    .filter((t) => t.length > 0 && !t.startsWith('/'));
  if (customerLines.length === 0) return null;

  const signalLines = customerLines.filter(hasBusinessSignal);
  if (signalLines.length === 0) return null;

  const joined = customerLines.join('  ');
  // The longest signal-bearing line is the most useful evidence for the human.
  const trigger = signalLines
    .slice()
    .sort((a, b) => b.length - a.length)[0]!;

  const intentCategory = detectIntent(joined);
  const occasion = detectOccasion(joined);
  const qty = detectQuantity(joined);
  const budget = detectBudget(joined);

  const input: RecordInput = {
    intentCategory,
    ...(occasion ? { occasion } : {}),
    ...(qty ? { quantity: qty.quantity, quantityRaw: qty.raw } : {}),
    ...(budget?.perGift ? { budgetPerGiftInr: budget.perGift } : {}),
    ...(budget?.total ? { budgetTotalInr: budget.total } : {}),
    ...(budget ? { budgetRaw: budget.raw } : {}),
    summaryBrief: buildSummary({ intentCategory, occasion, qty, budget }),
    triggerExcerpt: trigger.slice(0, 280),
  };
  return { input, trigger };
}

function buildSummary(parts: {
  intentCategory: IntentCategory;
  occasion?: string;
  qty?: { quantity: number; raw: string };
  budget?: { perGift?: number; total?: number; raw: string };
}): string {
  const bits: string[] = [];
  if (parts.occasion) bits.push(parts.occasion);
  bits.push(parts.intentCategory.replace(/_/g, ' '));
  if (parts.qty) bits.push(`~${parts.qty.quantity}`);
  if (parts.budget?.raw) bits.push(parts.budget.raw);
  // Flag clearly that this was reconstructed, so the team knows to verify it.
  return `Auto-recovered from chat (needs review): ${bits.join(' · ')}`;
}
