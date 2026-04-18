import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export type SessionHookCause = 'session-start' | 'pre-compact' | 'session-stop';

interface SessionHookSpec {
  event: 'SessionStart' | 'PreCompact' | 'Stop';
  cause: SessionHookCause;
}

interface HookMatcherEntry {
  matcher: string;
  hooks: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface SessionHookChange {
  event: SessionHookSpec['event'];
  command: string;
}

export interface SessionHookInstallPlan {
  settingsPath: string;
  beforeText: string;
  afterText: string;
  changed: boolean;
  added: SessionHookChange[];
}

const SESSION_HOOK_SPECS: SessionHookSpec[] = [
  { event: 'SessionStart', cause: 'session-start' },
  { event: 'PreCompact', cause: 'pre-compact' },
  { event: 'Stop', cause: 'session-stop' },
];

function resolveSessionHookCliPath(): string {
  const runtimeResolved = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'index.js',
  );
  if (fs.existsSync(runtimeResolved)) {
    return runtimeResolved;
  }
  return path.resolve(process.cwd(), 'dist', 'cli', 'index.js');
}

function buildHookCommand(
  cause: SessionHookCause,
  cliPath = resolveSessionHookCliPath(),
): string {
  return `node ${JSON.stringify(cliPath)} session-hook --cause=${cause}`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeEventEntries(value: unknown): HookMatcherEntry[] {
  if (!Array.isArray(value)) return [];

  const normalized: HookMatcherEntry[] = [];
  for (const entry of value) {
    const obj = asObject(entry);
    const matcher =
      typeof obj.matcher === 'string' && obj.matcher.trim()
        ? obj.matcher.trim()
        : '*';
    const hooksRaw = Array.isArray(obj.hooks) ? obj.hooks : [];
    const hooks = hooksRaw
      .map((hook) => asObject(hook))
      .filter((hook) => Object.keys(hook).length > 0);
    normalized.push({ ...obj, matcher, hooks });
  }

  return normalized;
}

function hasCommand(
  entries: HookMatcherEntry[],
  expectedCommand: string,
): boolean {
  for (const entry of entries) {
    for (const hook of entry.hooks) {
      if (hook.type === 'command' && hook.command === expectedCommand) {
        return true;
      }
    }
  }
  return false;
}

function findDefaultMatcherEntry(
  entries: HookMatcherEntry[],
): HookMatcherEntry | null {
  for (const entry of entries) {
    if (entry.matcher === '*') return entry;
  }
  return null;
}

export function defaultClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export function buildSessionHookInstallPlan(
  settingsPath = defaultClaudeSettingsPath(),
  cliPath = resolveSessionHookCliPath(),
): SessionHookInstallPlan {
  let beforeText = '';
  if (fs.existsSync(settingsPath)) {
    beforeText = fs.readFileSync(settingsPath, 'utf-8');
  }

  const parsedRoot = (() => {
    if (!beforeText.trim()) return {};
    const parsed = JSON.parse(beforeText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected JSON object at root.');
    }
    return parsed as Record<string, unknown>;
  })();

  const mergedRoot = { ...parsedRoot };
  const hooksRoot = asObject(mergedRoot.hooks);
  const added: SessionHookChange[] = [];

  for (const spec of SESSION_HOOK_SPECS) {
    const expectedCommand = buildHookCommand(spec.cause, cliPath);
    const entries = normalizeEventEntries(hooksRoot[spec.event]);
    if (hasCommand(entries, expectedCommand)) {
      hooksRoot[spec.event] = entries;
      continue;
    }

    const defaultEntry =
      findDefaultMatcherEntry(entries) ||
      ({ matcher: '*', hooks: [] } as HookMatcherEntry);
    if (!entries.includes(defaultEntry)) {
      entries.push(defaultEntry);
    }
    defaultEntry.hooks.push({
      type: 'command',
      command: expectedCommand,
    });
    hooksRoot[spec.event] = entries;
    added.push({
      event: spec.event,
      command: expectedCommand,
    });
  }

  mergedRoot.hooks = hooksRoot;
  const afterText = `${JSON.stringify(mergedRoot, null, 2)}\n`;

  return {
    settingsPath,
    beforeText,
    afterText,
    changed: added.length > 0,
    added,
  };
}

export function formatSessionHookInstallDiff(
  plan: SessionHookInstallPlan,
): string {
  if (!plan.changed) {
    return `No hook changes needed in ${plan.settingsPath}.`;
  }

  const lines: string[] = [
    `Planned changes for ${plan.settingsPath}:`,
    ...plan.added.map((change) => `+ ${change.event}: ${change.command}`),
  ];
  return lines.join('\n');
}

export function applySessionHookInstallPlan(
  plan: SessionHookInstallPlan,
): void {
  if (!plan.changed) return;
  fs.mkdirSync(path.dirname(plan.settingsPath), { recursive: true });
  fs.writeFileSync(plan.settingsPath, plan.afterText, 'utf-8');
}
