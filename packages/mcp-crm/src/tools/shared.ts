import { z } from 'zod';
import { getVerifiedIdentity } from '../identity/identity-context.js';

export type ToolContent = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function jsonContent(value: unknown): ToolContent {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function toolErrorContent(code: string, message?: string): ToolContent {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: { code, message: message ?? code } }),
      },
    ],
    isError: true,
  };
}

// Bare digits only — matches how conversations/agent_sessions store the phone
// (the dashboard join key). The verified identity is the ONLY trusted source;
// a phone in tool args is never used.
export function normalizePhone(raw?: string): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, '');
  return digits.length > 0 ? digits : undefined;
}

export function getCallerPhone(): string | undefined {
  return normalizePhone(getVerifiedIdentity()?.phone ?? undefined);
}

// Field schemas shared across record_query / upgrade_to_lead / update_record.
// Keys match RecordInput exactly, so validated args pass straight through. The
// agent fills only what it has actually learned in the conversation.
export const commonFields = {
  intentCategory: z
    .enum([
      'shopping',
      'gifting_personal',
      'gifting_b2b',
      'corporate',
      'reorder',
      'other',
    ])
    .optional()
    .describe(
      'Pick EXACTLY ONE of the listed values (never combine them): ' +
        'shopping = buying for themselves; ' +
        'gifting_personal = a personal gift for family/friend, small scale; ' +
        'gifting_b2b = gifting to clients, partners, or other businesses; ' +
        'corporate = a company buying for its own staff/employees (office/team gifting) or bulk/corporate procurement; ' +
        'reorder = repeating a past order; other = anything else.',
    ),
  occasion: z
    .string()
    .optional()
    .describe('Occasion in plain words, e.g. "Diwali", "wedding", "office party".'),
  quantity: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Number of units/gifts as a number (for scoring).'),
  quantityRaw: z
    .string()
    .optional()
    .describe('The customer\'s own phrasing of quantity, e.g. "around 300".'),
  budgetPerGiftInr: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Budget PER gift in INR (for scoring). Prefer this when known.'),
  budgetTotalInr: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Total budget in INR (used to derive per-gift if per-gift unknown).'),
  budgetRaw: z
    .string()
    .optional()
    .describe('The customer\'s own phrasing of budget, e.g. "₹500 a box".'),
  budgetUndecided: z
    .boolean()
    .optional()
    .describe('True if the customer is genuinely undecided on budget.'),
  // Defensive: the model frequently sends an array of cities for a plural
  // "location(s)" field. Accept that and join to one string (locations is
  // non-scoring free text; locationScope drives delivery points), so a natural
  // array never costs a failed tool round-trip. A plain string passes through.
  locations: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? value
              .filter((item) => typeof item === 'string' && item.trim().length > 0)
              .join(', ')
          : value,
      z
        .string()
        .describe(
          'Delivery location(s) as ONE string, e.g. "Mumbai and Delhi". An array of city strings is also accepted and joined.',
        )
        .optional(),
    ),
  locationScope: z
    .enum(['single', 'multi_drop_city', 'multi_city', 'pan_india'])
    .optional()
    .describe(
      'Delivery scope for scoring: single (one address), multi_drop_city (several drops in one city), multi_city (multiple cities), pan_india.',
    ),
  timeline: z
    .string()
    .optional()
    .describe('When they need it, in plain words, e.g. "before Diwali", "2 weeks".'),
  timelineDays: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Days until they need it (for scoring), if a concrete date is known.'),
  timelineExploring: z
    .boolean()
    .optional()
    .describe('True if just exploring with no concrete date yet.'),
  buyerType: z
    .enum([
      'personal',
      'wedding_event',
      'small_business',
      'employee_gifting',
      'client_vip_procurement',
    ])
    .optional()
    .describe('Who the buyer is (for scoring).'),
  customisation: z
    .enum(['none', 'note_card', 'logo', 'custom_packaging', 'bespoke'])
    .optional()
    .describe('Customisation level requested (for scoring).'),
  contactEmail: z
    .string()
    .optional()
    .describe(
      'The raw email address the customer shared, exactly as given (e.g. "priya@acme.com"). Just pass it through — the system classifies contact quality from it.',
    ),
  contactPhone: z
    .string()
    .optional()
    .describe('A raw phone/alternate number the customer shared, if any.'),
  contactQuality: z
    .enum(['name_only', 'phone', 'email_phone', 'corporate_email'])
    .optional()
    .describe(
      'Usually leave this BLANK — instead pass contactEmail / contactPhone and the system derives this for scoring. Only set it directly if you must override.',
    ),
  customerName: z
    .string()
    .optional()
    .describe('Customer or company name, if shared.'),
  conversationId: z
    .string()
    .optional()
    .describe('Internal conversation id, if known. Usually omit.'),
  summaryBrief: z
    .string()
    .optional()
    .describe(
      'One short line for the human team summarising the opportunity, e.g. "300 Diwali boxes for staff, ~₹1.5k each, Mumbai+Delhi, 10 days".',
    ),
  triggerExcerpt: z
    .string()
    .optional()
    .describe('A short quote of the customer line that triggered this capture.'),
};
