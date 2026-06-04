// Lead scoring — the Boondi Orchestration Blueprint v3 model, VERBATIM.
//
// The docs are the source of truth (HARD RULE). The point values below are
// copied exactly from the Blueprint's "7 Scoring Dimensions" tables and the
// band thresholds from its "Score bands — 0 to 100". The agent/reconciler
// submit RAW fields; scoring is deterministic here (objective, out of the LLM,
// out of Gantry core). Each dimension is mapped raw -> category -> points.
//
// Dimensions & maxima (sum = 100):
//   Quantity 25 · Budget/gift 20 · Buyer type 15 · Customisation 15 ·
//   Delivery 10 · Timeline 10 · Contact quality 5
//
// QUERY creation is never gated on score; score is computed only when a record
// becomes a LEAD and drives the human team's priority/band.

export type Band = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

// Agent-facing category enums (the agent/reconciler classify into these).
export type BuyerType =
  | 'personal'
  | 'wedding_event'
  | 'small_business'
  | 'employee_gifting'
  | 'client_vip_procurement';

export type Customisation =
  | 'none'
  | 'note_card'
  | 'logo'
  | 'custom_packaging'
  | 'bespoke';

export type LocationScope =
  | 'single'
  | 'multi_drop_city'
  | 'multi_city'
  | 'pan_india';

export type ContactQuality =
  | 'name_only'
  | 'phone'
  | 'email_phone'
  | 'corporate_email';

// Consumer/free email providers — a personal address, not a corporate signal.
const FREE_EMAIL_DOMAINS = new Set<string>([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in',
  'hotmail.com', 'hotmail.co.in', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
  'rediffmail.com', 'ymail.com', 'aol.com', 'zohomail.com',
]);

// Classify contact quality from the RAW email/phone the customer shared. The
// agent extracts raw contact details reliably but classifies the enum
// inconsistently, so — like every other dimension — we derive it deterministically
// here. A company-domain email is the strongest B2B signal; a free-provider email
// counts as email contact; a phone alone is weaker. Returns undefined when there
// is nothing to classify, so the caller keeps any value the agent set explicitly.
export function deriveContactQuality(
  email?: string | null,
  phone?: string | null,
): ContactQuality | undefined {
  const match = (email ?? '')
    .trim()
    .toLowerCase()
    .match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/);
  if (match) {
    return FREE_EMAIL_DOMAINS.has(match[1]!) ? 'email_phone' : 'corporate_email';
  }
  if ((phone ?? '').replace(/\D/g, '').length >= 7) return 'phone';
  return undefined;
}

export interface ScoringInput {
  quantity?: number;
  budgetPerGiftInr?: number;
  budgetUndecided?: boolean;
  buyerType?: BuyerType;
  customisation?: Customisation;
  locationScope?: LocationScope;
  timelineDays?: number;
  // When the customer is "just exploring" with no concrete date.
  timelineExploring?: boolean;
  contactQuality?: ContactQuality;
}

export interface ScoreBreakdown {
  quantity: number;
  budget: number;
  buyerType: number;
  customisation: number;
  delivery: number;
  timeline: number;
  contactQuality: number;
}

export interface ScoreResult {
  score: number;
  band: Band;
  breakdown: ScoreBreakdown;
}

// --- Dimension A: Quantity (max 25) ---
// <25 -> 0 · 25-100 -> 10 · 101-300 -> 18 · 301-1000 -> 22 · 1000+ -> 25
export function scoreQuantity(quantity?: number): number {
  if (quantity === undefined || !Number.isFinite(quantity) || quantity < 25) {
    return 0;
  }
  if (quantity <= 100) return 10;
  if (quantity <= 300) return 18;
  if (quantity <= 1000) return 22;
  return 25;
}

// --- Dimension B: Budget per gift (max 20) ---
// <₹500 -> 5 · undecided -> 8 · ₹500-1000 -> 10 · ₹1000-2000 -> 16 · ₹2000+ -> 20
export function scoreBudget(input: ScoringInput): number {
  const inr = input.budgetPerGiftInr;
  if (inr === undefined || !Number.isFinite(inr)) {
    return input.budgetUndecided ? 8 : 0;
  }
  if (inr < 500) return 5;
  if (inr < 1000) return 10; // ₹500–₹1,000
  if (inr <= 2000) return 16; // ₹1,000–₹2,000
  return 20; // ₹2,000+
}

// --- Dimension C: Buyer type (max 15) ---
// personal -> 2 · wedding/event -> 6 · small business -> 10 ·
// employee gifting -> 12 · client/VIP/procurement -> 15
const BUYER_TYPE_POINTS: Record<BuyerType, number> = {
  personal: 2,
  wedding_event: 6,
  small_business: 10,
  employee_gifting: 12,
  client_vip_procurement: 15,
};
export function scoreBuyerType(buyerType?: BuyerType): number {
  return buyerType ? BUYER_TYPE_POINTS[buyerType] : 0;
}

// --- Dimension D: Customisation (max 15) ---
// none -> 2 · note card -> 5 · logo print -> 10 · custom packaging -> 13 · full bespoke -> 15
const CUSTOMISATION_POINTS: Record<Customisation, number> = {
  none: 2,
  note_card: 5,
  logo: 10,
  custom_packaging: 13,
  bespoke: 15,
};
export function scoreCustomisation(c?: Customisation): number {
  return c ? CUSTOMISATION_POINTS[c] : 0;
}

// --- Dimension E: Delivery scope (max 10) ---
// single -> 3 · multi-drop one city -> 5 · multiple cities -> 8 · pan-India -> 10
const DELIVERY_POINTS: Record<LocationScope, number> = {
  single: 3,
  multi_drop_city: 5,
  multi_city: 8,
  pan_india: 10,
};
export function scoreDelivery(scope?: LocationScope): number {
  return scope ? DELIVERY_POINTS[scope] : 0;
}

// --- Dimension F: Timeline urgency (max 10) ---
// just exploring -> 2 · 3+ weeks (>21d) -> 5 · 1-3 weeks (8-21d) -> 8 · under 1 week (<=7d) -> 10
export function scoreTimeline(input: ScoringInput): number {
  const days = input.timelineDays;
  if (days === undefined || !Number.isFinite(days)) {
    return input.timelineExploring ? 2 : 0;
  }
  if (days <= 7) return 10;
  if (days <= 21) return 8;
  return 5; // 3+ weeks away
}

// --- Dimension G: Contact quality (max 5) ---
// name only -> 1 · phone -> 2 · email+phone -> 3 · corporate email -> 5
const CONTACT_POINTS: Record<ContactQuality, number> = {
  name_only: 1,
  phone: 2,
  email_phone: 3,
  corporate_email: 5,
};
export function scoreContactQuality(c?: ContactQuality): number {
  return c ? CONTACT_POINTS[c] : 0;
}

// Band thresholds (Blueprint): P5 0-24 · P4 25-49 · P3 50-69 · P2 70-84 · P1 85-100.
export function bandForScore(score: number): Band {
  if (score >= 85) return 'P1';
  if (score >= 70) return 'P2';
  if (score >= 50) return 'P3';
  if (score >= 25) return 'P4';
  return 'P5';
}

export function scoreLead(input: ScoringInput): ScoreResult {
  const breakdown: ScoreBreakdown = {
    quantity: scoreQuantity(input.quantity),
    budget: scoreBudget(input),
    buyerType: scoreBuyerType(input.buyerType),
    customisation: scoreCustomisation(input.customisation),
    delivery: scoreDelivery(input.locationScope),
    timeline: scoreTimeline(input),
    contactQuality: scoreContactQuality(input.contactQuality),
  };
  const score =
    breakdown.quantity +
    breakdown.budget +
    breakdown.buyerType +
    breakdown.customisation +
    breakdown.delivery +
    breakdown.timeline +
    breakdown.contactQuality;
  return { score, band: bandForScore(score), breakdown };
}
