import { isPlainObject } from './object.js';
import type { PermissionApprovalSuggestion } from './types.js';

const PERMISSION_BEHAVIORS = new Set(['allow', 'deny', 'ask']);
const PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);
const PERMISSION_DESTINATIONS = new Set([
  'userSettings',
  'projectSettings',
  'localSettings',
  'session',
  'cliArg',
]);

function boundedString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : undefined;
}

function parseDestination(
  value: unknown,
  forceSessionDestination: boolean,
): PermissionApprovalSuggestion['destination'] | undefined {
  if (forceSessionDestination) return 'session';
  return typeof value === 'string' && PERMISSION_DESTINATIONS.has(value)
    ? (value as PermissionApprovalSuggestion['destination'])
    : undefined;
}

function parseRules(value: unknown):
  | Array<{
      toolName: string;
      ruleContent?: string;
    }>
  | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    return undefined;
  }
  const rules = value.map((entry) => {
    if (!isPlainObject(entry)) return undefined;
    const toolName = boundedString(entry.toolName, 120);
    if (!toolName) return undefined;
    const ruleContent = boundedString(entry.ruleContent, 500);
    return {
      toolName,
      ...(ruleContent ? { ruleContent } : {}),
    };
  });
  return rules.every(Boolean)
    ? (rules as Array<{ toolName: string; ruleContent?: string }>)
    : undefined;
}

function parseDirectories(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    return undefined;
  }
  const directories = value.map((entry) => boundedString(entry, 500));
  return directories.every(Boolean) ? (directories as string[]) : undefined;
}

export function sanitizePermissionUpdate(
  value: unknown,
  options: { forceSessionDestination?: boolean } = {},
): PermissionApprovalSuggestion | undefined {
  if (!isPlainObject(value) || typeof value.type !== 'string') return undefined;
  const destination = parseDestination(
    value.destination,
    Boolean(options.forceSessionDestination),
  );
  if (!destination) return undefined;

  if (
    value.type === 'addRules' ||
    value.type === 'replaceRules' ||
    value.type === 'removeRules'
  ) {
    const rules = parseRules(value.rules);
    const behavior =
      typeof value.behavior === 'string' &&
      PERMISSION_BEHAVIORS.has(value.behavior)
        ? value.behavior
        : undefined;
    if (!rules || !behavior) return undefined;
    return {
      type: value.type,
      rules,
      behavior: behavior as 'allow' | 'deny' | 'ask',
      destination,
    };
  }

  if (value.type === 'setMode') {
    const mode =
      typeof value.mode === 'string' && PERMISSION_MODES.has(value.mode)
        ? value.mode
        : undefined;
    if (!mode) return undefined;
    return {
      type: 'setMode',
      mode: mode as
        | 'default'
        | 'acceptEdits'
        | 'bypassPermissions'
        | 'plan'
        | 'dontAsk'
        | 'auto',
      destination,
    };
  }

  if (value.type === 'addDirectories' || value.type === 'removeDirectories') {
    const directories = parseDirectories(value.directories);
    if (!directories) return undefined;
    return {
      type: value.type,
      directories,
      destination,
    };
  }

  return undefined;
}

export function sanitizePermissionUpdates(
  value: unknown,
  options: { forceSessionDestination?: boolean } = {},
): PermissionApprovalSuggestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const updates = value
    .slice(0, 8)
    .map((entry) => sanitizePermissionUpdate(entry, options))
    .filter((entry): entry is PermissionApprovalSuggestion => Boolean(entry));
  return updates.length > 0 ? updates : undefined;
}