import { describe, expect, it } from 'vitest';

import { isTransientExtractorError } from '@core/memory/extractor-llm-errors.js';

describe('isTransientExtractorError', () => {
  it.each([
    [{ status: 429 }, 'direct 429 status'],
    [{ status: 503 }, 'direct 503 status'],
    [{ response: { status: 429 } }, 'nested 429 response status'],
    [{ response: { status: 503 } }, 'nested 503 response status'],
    [new Error('request timeout while calling extractor'), 'timeout message'],
    [new Error('ECONNRESET from provider'), 'connection reset message'],
    [new Error('service unavailable'), 'service unavailable message'],
    [new Error('temporary provider failure'), 'temporary failure message'],
    [new Error('rate limit exceeded'), 'rate limit message'],
  ])('treats %s as transient', (err) => {
    expect(isTransientExtractorError(err)).toBe(true);
  });

  it.each([
    [{ status: 400 }, 'direct non-transient status'],
    [{ response: { status: 401 } }, 'nested non-transient response status'],
    [new Error('invalid JSON payload'), 'ordinary parser error'],
    ['timeout as plain string', 'non-error string'],
    [null, 'null'],
    [undefined, 'undefined'],
  ])('treats %s as non-transient', (err) => {
    expect(isTransientExtractorError(err)).toBe(false);
  });
});
