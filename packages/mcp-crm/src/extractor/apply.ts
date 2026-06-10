import type { RecordsRepository } from '../db/records-repository.js';
import type { BusinessRecord, RecordInput } from '../db/types.js';
import type { ExtractedOpportunity } from './types.js';

const NEEDS_REVIEW_BELOW = 0.5;

function toRecordInput(o: ExtractedOpportunity): RecordInput {
  return {
    intentCategory: o.intentCategory,
    occasion: o.occasion,
    quantity: o.quantity,
    quantityRaw: o.quantityRaw,
    budgetPerGiftInr: o.budgetPerGiftInr,
    budgetTotalInr: o.budgetTotalInr,
    budgetRaw: o.budgetRaw,
    budgetUndecided: o.budgetUndecided,
    locations: o.locations,
    locationScope: o.locationScope,
    timeline: o.timeline,
    timelineDays: o.timelineDays,
    timelineExploring: o.timelineExploring,
    buyerType: o.buyerType,
    customisation: o.customisation,
    contactEmail: o.contactEmail,
    contactPhone: o.contactPhone,
    customerName: o.customerName,
    summaryBrief: o.summaryBrief,
    triggerExcerpt: o.evidenceQuote,
  };
}

// Score (deterministic, inside repo.merge when status becomes lead) + upsert.
export async function applyExtraction(
  repo: RecordsRepository,
  args: {
    phone: string;
    conversationId: string;
    opportunities: ExtractedOpportunity[];
  },
): Promise<{
  created: number;
  updated: number;
  records: Array<{ action: 'created' | 'updated'; record: BusinessRecord }>;
}> {
  let created = 0;
  let updated = 0;
  const records: Array<{
    action: 'created' | 'updated';
    record: BusinessRecord;
  }> = [];
  for (const o of args.opportunities) {
    const saved = await repo.upsertOpportunity({
      match: o.match,
      phone: args.phone,
      conversationId: args.conversationId,
      input: toRecordInput(o),
      targetLead: o.isLead,
      source: 'extractor',
      confidence: o.confidence,
      needsReview: o.confidence < NEEDS_REVIEW_BELOW,
    });
    if (o.match && saved.id === o.match) {
      updated += 1;
      records.push({ action: 'updated', record: saved });
    } else {
      created += 1;
      records.push({ action: 'created', record: saved });
    }
  }
  return { created, updated, records };
}
