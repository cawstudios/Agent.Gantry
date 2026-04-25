import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(duration);
dayjs.extend(utc);

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
  return dayjs(clock.nowMs()).utc().toISOString();
}

export function nowMs(clock: Clock = systemClock): number {
  return clock.nowMs();
}

export function toIso(input: Date | number | string): string {
  return dayjs(toDate(input)).utc().toISOString();
}

export function parseIso(value: string): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = dayjs(trimmed);
  if (!parsed.isValid()) return undefined;
  return parsed.toDate();
}

export function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return '0ms';
  const sign = durationMs < 0 ? '-' : '';
  const abs = Math.abs(Math.round(durationMs));
  const d = dayjs.duration(abs);
  const parts: string[] = [];
  const hours = Math.floor(d.asHours());
  const minutes = d.minutes();
  const seconds = d.seconds();
  const milliseconds = d.milliseconds();
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
  const parsed = dayjs(input);
  if (!parsed.isValid()) {
    throw new Error(`Invalid date input: ${String(input)}`);
  }
  return parsed.toDate();
}
