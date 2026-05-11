export interface Clock {
  now: () => Date;
  nowMs: () => number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

export function fixedClock(input: Date | number | string): Clock {
  const fixed = toDate(input);
  const fixedMs = fixed.getTime();
  return {
    now: () => new Date(fixedMs),
    nowMs: () => fixedMs,
  };
}

export function nowIso(clock: Clock = systemClock): string {
  return new Date(clock.nowMs()).toISOString();
}

export function nowMs(clock: Clock = systemClock): number {
  return clock.nowMs();
}

export function nowDate(clock: Clock = systemClock): Date {
  return clock.now();
}

export function toIso(input: Date | number | string): string {
  return toDate(input).toISOString();
}

export function parseIso(value: string): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return '0ms';
  const sign = durationMs < 0 ? '-' : '';
  const abs = Math.abs(Math.round(durationMs));
  const parts: string[] = [];
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1_000);
  const milliseconds = abs % 1_000;
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || minutes > 0 || hours > 0) parts.push(`${seconds}s`);
  parts.push(`${milliseconds}ms`);
  return `${sign}${parts.join(' ')}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDate(input: Date | number | string): Date {
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date input: ${String(input)}`);
  }
  return parsed;
}
