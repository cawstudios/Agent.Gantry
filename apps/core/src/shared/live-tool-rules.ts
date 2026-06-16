import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirSync, writePrivateFileSync } from './private-fs.js';

const LIVE_TOOL_RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const LIVE_TOOL_RULES_DIR = 'live-tool-rules';

export interface LiveToolRulesSnapshot {
  ipcDir: string;
  runHandle: string;
  rules: string[];
}

type LiveToolRulesListener = (snapshot: LiveToolRulesSnapshot) => void;

const cachedRulesByRunHandle = new Map<string, string[]>();
const liveToolRulesListeners = new Set<LiveToolRulesListener>();

export function readLiveToolRules(input: {
  ipcDir?: string;
  runHandle?: string;
}): string[] {
  const filePath = liveToolRulesPath(input);
  const runHandle = normalizeRunHandle(input.runHandle);
  if (!filePath) return cachedRulesFor(runHandle);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return normalizeRuleList(parsed);
  } catch (err) {
    if (!isExpectedReadMiss(err)) throw err;
    return cachedRulesFor(runHandle);
  }
}

export function appendLiveToolRules(input: {
  ipcDir?: string;
  runHandle?: string;
  rules: readonly string[];
}): string[] {
  const filePath = liveToolRulesPath(input);
  if (!filePath) return [];
  const next = mergeRules(readLiveToolRulesFile(filePath) ?? [], input.rules);
  ensurePrivateDirSync(path.dirname(filePath));
  writePrivateFileSync(filePath, JSON.stringify(next, null, 2));
  replaceCachedLiveToolRules({ runHandle: input.runHandle, rules: next });
  notifyLiveToolRules({
    ipcDir: input.ipcDir,
    runHandle: input.runHandle,
    rules: next,
  });
  return next;
}

export function removeLiveToolRules(input: {
  ipcDir?: string;
  runHandle?: string;
  rules: readonly string[];
}): string[] {
  const filePath = liveToolRulesPath(input);
  if (!filePath) return [];
  const remove = new Set(normalizeRuleList(input.rules));
  const next = (readLiveToolRulesFile(filePath) ?? []).filter(
    (rule) => !remove.has(rule),
  );
  ensurePrivateDirSync(path.dirname(filePath));
  writePrivateFileSync(filePath, JSON.stringify(next, null, 2));
  replaceCachedLiveToolRules({ runHandle: input.runHandle, rules: next });
  notifyLiveToolRules({
    ipcDir: input.ipcDir,
    runHandle: input.runHandle,
    rules: next,
  });
  return next;
}

export function replaceCachedLiveToolRules(input: {
  runHandle?: string;
  rules: readonly string[];
}): string[] {
  const runHandle = normalizeRunHandle(input.runHandle);
  if (!runHandle) return [];
  const rules = normalizeRuleList(input.rules);
  cachedRulesByRunHandle.set(runHandle, rules);
  return rules;
}

export function replaceCachedLiveToolRulesFromPayload(
  payload: Record<string, unknown>,
): string[] {
  return replaceCachedLiveToolRules({
    runHandle:
      typeof payload.runHandle === 'string' ? payload.runHandle : undefined,
    rules: Array.isArray(payload.rules) ? payload.rules : [],
  });
}

export function subscribeLiveToolRules(
  listener: LiveToolRulesListener,
): () => void {
  liveToolRulesListeners.add(listener);
  return () => {
    liveToolRulesListeners.delete(listener);
  };
}

export function clearLiveToolRuleCachesForTest(): void {
  cachedRulesByRunHandle.clear();
  liveToolRulesListeners.clear();
}

function liveToolRulesPath(input: {
  ipcDir?: string;
  runHandle?: string;
}): string | null {
  const ipcDir = input.ipcDir?.trim();
  const runHandle = normalizeRunHandle(input.runHandle);
  if (!ipcDir || !runHandle) {
    return null;
  }
  return path.join(ipcDir, LIVE_TOOL_RULES_DIR, `${runHandle}.json`);
}

function normalizeRunHandle(value: string | undefined): string | undefined {
  const runHandle = value?.trim();
  if (!runHandle || !LIVE_TOOL_RULE_ID_RE.test(runHandle)) return undefined;
  return runHandle;
}

function cachedRulesFor(runHandle: string | undefined): string[] {
  if (!runHandle) return [];
  return [...(cachedRulesByRunHandle.get(runHandle) ?? [])];
}

function notifyLiveToolRules(input: {
  ipcDir?: string;
  runHandle?: string;
  rules: readonly string[];
}): void {
  const ipcDir = input.ipcDir?.trim();
  const runHandle = normalizeRunHandle(input.runHandle);
  if (!ipcDir || !runHandle) return;
  const snapshot: LiveToolRulesSnapshot = {
    ipcDir,
    runHandle,
    rules: normalizeRuleList(input.rules),
  };
  for (const listener of liveToolRulesListeners) {
    listener(snapshot);
  }
}

function isExpectedReadMiss(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function readLiveToolRulesFile(filePath: string): string[] | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return normalizeRuleList(parsed);
  } catch (err) {
    if (!isExpectedReadMiss(err)) throw err;
    return undefined;
  }
}

function mergeRules(
  baseRules: readonly string[],
  nextRules: readonly string[],
): string[] {
  const out = new Set(baseRules);
  for (const rule of normalizeRuleList(nextRules)) out.add(rule);
  return [...out];
}

function normalizeRuleList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const rule = typeof item === 'string' ? item.trim() : '';
    if (rule) out.add(rule);
  }
  return [...out];
}
