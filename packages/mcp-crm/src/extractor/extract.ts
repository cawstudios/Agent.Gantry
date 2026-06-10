import { extractionResultSchema, type ExtractionInput, type ExtractionResult } from './types.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionMessages } from './prompt.js';
import type { ExtractorLlm } from './llm-client.js';

function parseJsonLoose(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no JSON object in model output');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    // V8's JSON.parse message quotes a snippet of the raw input — which can
    // contain customer data (phone digits). Callers that need the raw head
    // for debugging get it via onFailure's rawHead; the reason must stay
    // content-free.
    throw new Error('invalid JSON in model output');
  }
}

// One model call → validated opportunities. Returns null on unrecoverable
// parse/validation failure (caller skips, cursor not advanced → retried later).
// The optional onFailure hook surfaces WHY (zod reason + a head of the raw model
// output) so a silent null does not hide a prompt/schema drift in the logs.
export async function extractOpportunities(
  llm: ExtractorLlm,
  input: ExtractionInput,
  onFailure?: (detail: { reason: string; rawHead: string }) => void,
): Promise<ExtractionResult | null> {
  const raw = await llm.complete({
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: buildExtractionMessages(input),
  });
  try {
    const parsed = extractionResultSchema.parse(parseJsonLoose(raw));
    return parsed;
  } catch (err) {
    onFailure?.({
      reason: err instanceof Error ? err.message : String(err),
      rawHead: raw.slice(0, 600),
    });
    return null;
  }
}
