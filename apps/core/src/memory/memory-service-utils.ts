import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { MemoryItem } from './memory-types.js';
import type { ArcTurn } from './memory-service-types.js';

export function isStalePatchError(err: unknown): boolean {
  return err instanceof Error && /stale patch/i.test(err.message);
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function fingerprintSensitiveToken(value: string): string {
  const hash = sha256(value);
  return `${hash.slice(0, 12)}:${value.length}`;
}

export function clampConfidence(value: number | undefined): number {
  if (value === undefined) return 0.7;
  return Math.max(0, Math.min(1, value));
}

export function chunkText(
  text: string,
  size: number,
  overlap: number,
): string[] {
  const chunks: string[] = [];
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return chunks;

  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + size);
    chunks.push(normalized.slice(start, end));
    if (end === normalized.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'object' &&
      part !== null &&
      'text' in part &&
      typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join('');
}

export function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string',
    )
    .map((part) => part.text as string)
    .join('');
}

export function parseTranscriptArc(
  transcriptPath: string,
  maxTurns: number,
): ArcTurn[] {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const turns: ArcTurn[] = [];

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      const candidate = JSON.parse(trimmed) as unknown;
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      ) {
        continue;
      }
      parsed = candidate as Record<string, unknown>;
    } catch {
      continue;
    }

    const roleRaw =
      (typeof parsed.type === 'string' ? parsed.type : undefined) ||
      (typeof parsed.role === 'string' ? parsed.role : undefined);
    const normalizedRole = roleRaw?.trim().toLowerCase();
    if (normalizedRole !== 'user' && normalizedRole !== 'assistant') {
      continue;
    }

    const message = parsed.message;
    const contentValue =
      message && typeof message === 'object' && !Array.isArray(message)
        ? (message as Record<string, unknown>).content
        : parsed.content;
    const text =
      normalizedRole === 'user'
        ? extractUserText(contentValue).trim()
        : extractAssistantText(contentValue).trim();
    if (!text) continue;
    turns.push({ role: normalizedRole, text });
  }

  if (turns.length <= maxTurns) return turns;
  return turns.slice(turns.length - maxTurns);
}

export function dedupeItemsById(items: MemoryItem[]): MemoryItem[] {
  const byId = new Map<string, MemoryItem>();
  for (const item of items) {
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

export function directorySizeKb(root: string): number {
  if (!root || !fs.existsSync(root)) return 0;
  let totalBytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (entry.isFile()) {
          totalBytes += fs.statSync(full).size;
        }
      } catch {
        // Best-effort accounting.
      }
    }
  }
  return Math.round(totalBytes / 1024);
}