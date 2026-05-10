import { isPlainObject } from '../shared/object.js';
import {
  isDirectSaveMemoryKind,
  PatchMemoryInput,
  PatchProcedureInput,
  SaveMemoryInput,
  SaveProcedureInput,
} from './memory-types.js';

type Obj = Record<string, unknown>;

export function parseOptionalString(
  value: unknown,
  opts: { maxLen?: number } = {},
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || (opts.maxLen && trimmed.length > opts.maxLen))
    return undefined;
  return trimmed;
}

export function parseOptionalNumber(
  value: unknown,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (opts.min !== undefined && value < opts.min) return undefined;
  if (opts.max !== undefined && value > opts.max) return undefined;
  return value;
}

export function parseSaveMemoryInput(payload: unknown): SaveMemoryInput {
  const input = objectPayload(payload, 'memory_save');
  const key = str(input, 'key', 256);
  const value = str(input, 'value', 10_000);
  if (!key || !value) throw new Error('memory_save requires key and value');
  const kind = directSaveMemoryKind(input);
  return omitUndefined({
    key,
    value,
    scope: scope(input.scope),
    kind,
    group_folder: str(input, 'group_folder', 128),
    user_id: str(input, 'user_id', 255),
    confidence: num(input, 'confidence', { min: 0, max: 1 }),
    why: str(input, 'why', 500),
    source_turn_id: str(input, 'source_turn_id', 255),
    load_bearing: bool(input, 'load_bearing'),
    supersedes: stringList(input.supersedes, 128, true),
    source: str(input, 'source', 255),
  }) as SaveMemoryInput;
}

export function parsePatchMemoryInput(payload: unknown): PatchMemoryInput {
  const input = objectPayload(payload, 'memory_patch');
  const id = str(input, 'id', 128);
  const expectedVersion = num(input, 'expected_version', { min: 1 });
  if (!id || expectedVersion === undefined)
    throw new Error('memory_patch requires id and expected_version');
  return omitUndefined({
    id,
    expected_version: Math.round(expectedVersion),
    key: str(input, 'key', 256),
    value: str(input, 'value', 10_000),
    why: str(input, 'why', 500),
    load_bearing: bool(input, 'load_bearing'),
    confidence: num(input, 'confidence', { min: 0, max: 1 }),
  }) as PatchMemoryInput;
}

export function parseDemoteMemoryInput(payload: unknown): {
  id: string;
  expectedVersion?: number;
  reason?: string;
} {
  const input = objectPayload(payload, 'memory_demote');
  const id = str(input, 'id', 128);
  if (!id) throw new Error('memory_demote requires id');
  const expectedVersion = num(input, 'expected_version', { min: 1 });
  return omitUndefined({
    id,
    expectedVersion:
      expectedVersion === undefined ? undefined : Math.round(expectedVersion),
    reason: str(input, 'reason', 500),
  });
}

export function parseReviewDecisionInput(payload: unknown): {
  reviewId: string;
  decision: 'approve' | 'reject' | 'edit_approve';
  editedValue?: string;
  editedReason?: string;
} {
  const input = objectPayload(payload, 'memory_review_decision');
  const reviewId = str(input, 'review_id', 128) || str(input, 'reviewId', 128);
  const decision = str(input, 'decision', 32);
  if (!reviewId) throw new Error('memory_review_decision requires review_id');
  if (!isReviewDecision(decision)) {
    throw new Error(
      'memory_review_decision.decision must be approve, reject, or edit_approve',
    );
  }
  return omitUndefined({
    reviewId,
    decision,
    editedValue: str(input, 'edited_value', 10_000),
    editedReason: str(input, 'edited_reason', 500),
  });
}

export function parseSaveProcedureInput(payload: unknown): SaveProcedureInput {
  const input = objectPayload(payload, 'procedure_save');
  const title = str(input, 'title', 256);
  const body = str(input, 'body', 50_000);
  if (!title || !body)
    throw new Error('procedure_save requires title and body');
  const originRaw = str(input, 'origin', 64);
  return omitUndefined({
    title,
    body,
    scope: scope(input.scope),
    group_folder: str(input, 'group_folder', 128),
    user_id: str(input, 'user_id', 255),
    tags: stringList(input.tags, 64),
    origin:
      originRaw === 'explicit' || originRaw === 'accepted_suggestion'
        ? originRaw
        : undefined,
    trigger: str(input, 'trigger', 280),
    confidence: num(input, 'confidence', { min: 0, max: 1 }),
    source: str(input, 'source', 255),
  }) as SaveProcedureInput;
}

export function parsePatchProcedureInput(
  payload: unknown,
): PatchProcedureInput {
  const input = objectPayload(payload, 'procedure_patch');
  const id = str(input, 'id', 128);
  const expectedVersion = num(input, 'expected_version', { min: 1 });
  if (!id || expectedVersion === undefined)
    throw new Error('procedure_patch requires id and expected_version');
  return omitUndefined({
    id,
    expected_version: Math.round(expectedVersion),
    title: str(input, 'title', 256),
    body: str(input, 'body', 50_000),
    tags: stringList(input.tags, 64),
    trigger: input.trigger === null ? null : str(input, 'trigger', 280),
    confidence: num(input, 'confidence', { min: 0, max: 1 }),
  }) as PatchProcedureInput;
}

function objectPayload(payload: unknown, action: string): Obj {
  if (!isPlainObject(payload))
    throw new Error(`${action} payload must be an object`);
  return payload;
}

function str(input: Obj, key: string, maxLen: number): string | undefined {
  return parseOptionalString(input[key], { maxLen });
}

function num(
  input: Obj,
  key: string,
  opts: { min?: number; max?: number },
): number | undefined {
  return parseOptionalNumber(input[key], opts);
}

function bool(input: Obj, key: string): boolean | undefined {
  return typeof input[key] === 'boolean' ? input[key] : undefined;
}

function stringList(
  value: unknown,
  maxLen: number,
  dropInvalid = false,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map((item) => parseOptionalString(item, { maxLen }));
  if (!dropInvalid && parsed.some((item) => !item)) return undefined;
  const out = parsed.filter((item): item is string => Boolean(item));
  return out.length ? out : undefined;
}

function scope(
  value: unknown,
): SaveMemoryInput['scope'] | SaveProcedureInput['scope'] | undefined {
  const parsed = parseOptionalString(value, { maxLen: 16 });
  return parsed === 'user' || parsed === 'group' || parsed === 'global'
    ? parsed
    : undefined;
}

function directSaveMemoryKind(input: Obj): SaveMemoryInput['kind'] | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, 'kind')) return undefined;
  const kind = parseOptionalString(input.kind, { maxLen: 32 });
  if (isDirectSaveMemoryKind(kind)) return kind;
  throw new Error(
    'memory_save.kind must be one of preference, decision, fact, correction, or constraint',
  );
}

function isReviewDecision(
  value: string | undefined,
): value is 'approve' | 'reject' | 'edit_approve' {
  return value === 'approve' || value === 'reject' || value === 'edit_approve';
}

function omitUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}
