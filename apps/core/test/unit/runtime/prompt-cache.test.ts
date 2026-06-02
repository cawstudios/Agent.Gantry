import { afterEach, expect, it } from 'vitest';

import {
  getCachedSystemPrompt,
  setCachedSystemPrompt,
  clearCachedSystemPrompt,
} from '@core/runtime/prompt-cache.js';

afterEach(() => clearCachedSystemPrompt());

it('stores and returns a compiled prompt by key', () => {
  setCachedSystemPrompt('boondi', 'PROMPT');
  expect(getCachedSystemPrompt('boondi')).toBe('PROMPT');
  expect(getCachedSystemPrompt('other')).toBeUndefined();
});

it('clears one key or all', () => {
  setCachedSystemPrompt('a', '1');
  setCachedSystemPrompt('b', '2');
  clearCachedSystemPrompt('a');
  expect(getCachedSystemPrompt('a')).toBeUndefined();
  expect(getCachedSystemPrompt('b')).toBe('2');
  clearCachedSystemPrompt();
  expect(getCachedSystemPrompt('b')).toBeUndefined();
});
