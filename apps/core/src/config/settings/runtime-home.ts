import fs from 'fs';
import os from 'os';
import path from 'path';

import { getMyclawHome } from '../../shared/myclaw-home.js';
import { ensureRuntimeLayoutDirectories } from '../../platform/runtime-layout.js';

export const DEFAULT_RUNTIME_HOME = path.join(os.homedir(), 'myclaw');

export function resolveRuntimeHome(raw?: string): string {
  const source =
    raw?.trim() || process.env.MYCLAW_HOME?.trim() || DEFAULT_RUNTIME_HOME;
  return getMyclawHome(source);
}

export function ensureRuntimeLayout(runtimeHome: string): void {
  ensureRuntimeLayoutDirectories(runtimeHome);
}

export function ensureRuntimeWritable(runtimeHome: string): void {
  ensureRuntimeLayout(runtimeHome);
  fs.accessSync(runtimeHome, fs.constants.W_OK);
}

export function envFilePath(runtimeHome: string): string {
  return path.join(runtimeHome, '.env');
}

export function settingsFilePath(runtimeHome: string): string {
  return path.join(runtimeHome, 'settings.yaml');
}

export function onboardingStatePath(runtimeHome: string): string {
  return path.join(runtimeHome, '.onboarding-state.json');
}

export function runtimeLogPath(runtimeHome: string): string {
  return path.join(runtimeHome, 'logs', 'myclaw.log');
}

export function runtimeErrorLogPath(runtimeHome: string): string {
  return path.join(runtimeHome, 'logs', 'myclaw.error.log');
}
