import crypto from 'crypto';

import type { ChunkInsert } from './store.js';

export const STALE_PATCH_MESSAGE_PREFIX = 'stale patch:';

export function nowIso(): string {
  return new Date().toISOString();
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function parseJsonArray(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

export function parseEmbedding(value: string | null): number[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const embedding = parsed.map(Number);
    return embedding.every(Number.isFinite) ? embedding : null;
  } catch {
    return null;
  }
}

export function likePattern(query: string): string {
  return `%${query.replace(/[%_]/g, '').trim()}%`;
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function chunkHash(input: ChunkInsert): string {
  return crypto
    .createHash('sha256')
    .update(
      `${input.scope}:${input.group_folder}:${input.topic_id || ''}:${input.source_type}:${input.source_id}:${input.text}`,
    )
    .digest('hex');
}