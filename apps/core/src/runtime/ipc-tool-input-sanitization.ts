import { isPlainObject } from '../shared/object.js';

const TOOL_INPUT_MAX_DEPTH = 2;
const TOOL_INPUT_MAX_KEYS = 40;
const TOOL_INPUT_MAX_ARRAY_ENTRIES = 20;
const TOOL_INPUT_MAX_STRING_LENGTH = 500;

export const SENSITIVE_TOOL_INPUT_KEY_PATTERN =
  /(secret|token|password|passphrase|credential|api[_-]?key|key|authorization|bearer|cookie|session)/i;

interface SanitizationState {
  altered: boolean;
}

function sanitizeValue(
  value: unknown,
  depth: number,
  state: SanitizationState,
): unknown {
  if (depth > TOOL_INPUT_MAX_DEPTH) {
    state.altered = true;
    return '[TRUNCATED_DEPTH]';
  }
  if (typeof value === 'string') {
    if (value.length <= TOOL_INPUT_MAX_STRING_LENGTH) return value;
    state.altered = true;
    return `${value.slice(0, TOOL_INPUT_MAX_STRING_LENGTH)}...[truncated]`;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > TOOL_INPUT_MAX_ARRAY_ENTRIES) state.altered = true;
    return value
      .slice(0, TOOL_INPUT_MAX_ARRAY_ENTRIES)
      .map((entry) => sanitizeValue(entry, depth + 1, state));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    let seen = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (seen >= TOOL_INPUT_MAX_KEYS) {
        state.altered = true;
        out.__omitted_keys = 'more';
        break;
      }
      seen += 1;
      const entry = value[key];
      if (SENSITIVE_TOOL_INPUT_KEY_PATTERN.test(key)) {
        state.altered = true;
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = sanitizeValue(entry, depth + 1, state);
    }
    return out;
  }
  state.altered = true;
  return String(value);
}

export function sanitizeIpcToolInput(value: unknown): {
  toolInput?: Record<string, unknown>;
  altered: boolean;
} {
  if (!isPlainObject(value)) return { altered: value !== undefined };
  const state: SanitizationState = { altered: false };
  return {
    toolInput: sanitizeValue(value, 0, state) as Record<string, unknown>,
    altered: state.altered,
  };
}
