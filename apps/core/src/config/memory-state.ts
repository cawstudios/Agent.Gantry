import path from 'path';

import { getMyclawHome } from '../shared/myclaw-home.js';
import { envConfig } from './env/index.js';
import {
  readRuntimeMemorySettingsSnapshot,
  type RuntimeMemorySettingsSnapshot,
} from './settings/runtime-settings.js';

const MYCLAW_HOME_RAW =
  process.env.MYCLAW_HOME?.trim() || envConfig.MYCLAW_HOME?.trim() || '';
export const MEMORY_CONFIG_HOME = getMyclawHome(MYCLAW_HOME_RAW);
export const MEMORY_CONFIG_ROOT = MEMORY_CONFIG_HOME;

export let runtimeMemorySettings: RuntimeMemorySettingsSnapshot = {};
let runtimeMemorySettingsError: Error | null = null;
try {
  runtimeMemorySettings = readRuntimeMemorySettingsSnapshot(MEMORY_CONFIG_HOME);
} catch (err) {
  runtimeMemorySettingsError =
    err instanceof Error ? err : new Error(String(err));
}
if (runtimeMemorySettingsError) {
  throw new Error(
    `Invalid runtime memory settings: ${runtimeMemorySettingsError.message}`,
  );
}

const memoryRootSetting = runtimeMemorySettings.root || 'memory';
export const memoryStorageDir = path.isAbsolute(memoryRootSetting)
  ? path.resolve(memoryRootSetting)
  : path.resolve(MEMORY_CONFIG_ROOT, memoryRootSetting);
export const RUNTIME_MEMORY_ENABLED = runtimeMemorySettings.enabled ?? true;

export function resolveRuntimeMemoryPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(MEMORY_CONFIG_ROOT, trimmed);
}