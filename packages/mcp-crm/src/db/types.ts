import type {
  Band,
  BuyerType,
  ContactQuality,
  Customisation,
  LocationScope,
} from '../scoring.js';

// Lifecycle of a business record. A QUERY is a soft signal (a human call could
// convert it); a LEAD is qualified/decided intent. handed_off/won/lost are for
// the human team (v1 dashboard is display-only, but the column exists).
export type BusinessStatus =
  | 'query'
  | 'qualifying'
  | 'lead'
  | 'handed_off'
  | 'won'
  | 'lost';

export const OPEN_STATUSES: readonly BusinessStatus[] = [
  'query',
  'qualifying',
  'lead',
];

export type IntentCategory =
  | 'shopping'
  | 'gifting_personal'
  | 'gifting_b2b'
  | 'corporate'
  | 'reorder'
  | 'other';

// One row = one business record (query or lead) for a customer.
export interface BusinessRecord {
  id: string;
  phone: string;
  customerName: string | null;
  conversationId: string | null;
  status: BusinessStatus;
  intentCategory: IntentCategory;
  occasion: string | null;
  quantity: number | null;
  quantityRaw: string | null;
  budgetPerGiftInr: number | null;
  budgetTotalInr: number | null;
  budgetRaw: string | null;
  locations: string | null;
  locationScope: LocationScope | null;
  timeline: string | null;
  timelineDays: number | null;
  buyerType: BuyerType | null;
  customisation: Customisation | null;
  contactQuality: ContactQuality | null;
  score: number | null;
  band: Band | null;
  summaryBrief: string | null;
  triggerExcerpt: string | null;
  source: string; // 'agent' (fast path) | 'reconciler' (durable backstop)
  createdAt: string;
  updatedAt: string;
}

// Fields the tools / reconciler can supply. All optional — captured
// incrementally over a conversation. `phone` is NEVER taken from here; it comes
// from the verified identity (or, for the reconciler, the session's user_id).
export interface RecordInput {
  customerName?: string;
  conversationId?: string;
  intentCategory?: IntentCategory;
  occasion?: string;
  quantity?: number;
  quantityRaw?: string;
  budgetPerGiftInr?: number;
  budgetTotalInr?: number;
  budgetRaw?: string;
  locations?: string;
  locationScope?: LocationScope;
  timeline?: string;
  timelineDays?: number;
  timelineExploring?: boolean;
  budgetUndecided?: boolean;
  buyerType?: BuyerType;
  customisation?: Customisation;
  // Raw contact details the customer shared. The connector derives
  // contactQuality (the scoring enum) from these; an explicit contactQuality
  // still wins if the agent sets one.
  contactEmail?: string;
  contactPhone?: string;
  contactQuality?: ContactQuality;
  summaryBrief?: string;
  triggerExcerpt?: string;
}
