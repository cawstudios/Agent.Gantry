import { describe, expect, it } from 'vitest';

import { LlmMemoryExtractionProvider } from '@core/memory/extractor-llm.js';

describe('LlmMemoryExtractionProvider', () => {
  it('exposes a provider-neutral status label', () => {
    expect(new LlmMemoryExtractionProvider().providerName).toBe('memory-llm');
  });
});
