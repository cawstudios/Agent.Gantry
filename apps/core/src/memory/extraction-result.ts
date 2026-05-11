import type {
  ExtractedMemoryFact,
  MemoryExtractionResult,
} from './extractor-types.js';

export function extractionResult(
  facts: ExtractedMemoryFact[],
  status: MemoryExtractionResult['status'] = facts.length > 0
    ? 'facts_extracted'
    : 'empty_qualified',
  zeroFactReason = facts.length === 0 ? 'no_qualifying_facts' : undefined,
): MemoryExtractionResult {
  return {
    facts,
    status,
    ...(zeroFactReason ? { zeroFactReason } : {}),
  };
}
