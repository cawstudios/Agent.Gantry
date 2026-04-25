import { describe, expect, it } from 'vitest';

import {
  fixedClock,
  formatDurationMs,
  nowIso,
  nowMs,
  parseIso,
  sleep,
  toIso,
} from '@core/infrastructure/time/datetime.js';

describe('datetime helpers', () => {
  it('returns deterministic values with fixedClock', () => {
    const clock = fixedClock('2026-04-21T00:00:00.123Z');
    expect(nowMs(clock)).toBe(1_776_729_600_123);
    expect(nowIso(clock)).toBe('2026-04-21T00:00:00.123Z');
  });

  it('parses and formats ISO timestamps', () => {
    const parsed = parseIso('2026-04-21T00:00:00.000Z');
    expect(parsed?.toISOString()).toBe('2026-04-21T00:00:00.000Z');
    expect(parseIso('')).toBeUndefined();
    expect(parseIso('bad-date')).toBeUndefined();
    expect(toIso('2026-04-21T00:00:00.000Z')).toBe('2026-04-21T00:00:00.000Z');
  });

  it('formats durations in a readable compact format', () => {
    expect(formatDurationMs(0)).toBe('0ms');
    expect(formatDurationMs(1_234)).toBe('1s 234ms');
    expect(formatDurationMs(3_661_250)).toBe('1h 1m 1s 250ms');
  });

  it('supports async sleep', async () => {
    const start = Date.now();
    await sleep(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(8);
  });
});
