import { isPlainObject } from '../shared/object.js';

const TOOL_INPUT_MAX_DEPTH = 2;
const TOOL_INPUT_MAX_KEYS = 40;
const TOOL_INPUT_MAX_ARRAY_ENTRIES = 20;
const TOOL_INPUT_MAX_STRING_LENGTH = 500;

export const SENSITIVE_TOOL_INPUT_KEY_PATTERN =
  /(secret|token|password|passphrase|credential|api[_-]?key|key|authorization|bearer|cookie|session)/i;

const AUTH_VALUE_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KNOWN_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[po]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abp]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g;
const ENV_VALUE_PATTERN =
  /\b([A-Za-z_][A-Za-z0-9_-]*)(\s*(?:=|:)\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/g;
const URL_USERINFO_PATTERN = /(:\/\/)[^\s/@:]+:[^\s/@]+@/g;

export function redactSensitiveToolInputString(value: string): string {
  return value
    .replace(URL_USERINFO_PATTERN, '$1[REDACTED]@')
    .replace(AUTH_VALUE_PATTERN, '[REDACTED]')
    .replace(KNOWN_TOKEN_PATTERN, '[REDACTED]')
    .replace(ENV_VALUE_PATTERN, (match, key: string, separator: string) =>
      SENSITIVE_TOOL_INPUT_KEY_PATTERN.test(key)
        ? `${key}${separator}[REDACTED]`
        : match,
    );
}

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
    const redacted = redactSensitiveToolInputString(value);
    if (redacted !== value) state.altered = true;
    if (redacted.length <= TOOL_INPUT_MAX_STRING_LENGTH) return redacted;
    state.altered = true;
    return `${redacted.slice(0, TOOL_INPUT_MAX_STRING_LENGTH)}...[truncated]`;
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
