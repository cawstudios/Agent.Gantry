import fs from 'fs';
import os from 'os';
import path from 'path';

import { upsertEnvFile } from '@core/config/env/file.js';
import { envFilePath } from '@core/config/settings/runtime-home.js';
import {
  createDefaultRuntimeSettings,
  saveRuntimeSettings,
  type RuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

export interface RuntimeHomeFixture {
  runtimeHome: string;
  envPath: string;
  settingsPath: string;
  writeEnv(updates: Record<string, string | null | undefined>): void;
  cleanup(): void;
}

export function createRuntimeHomeFixture(options?: {
  prefix?: string;
  mutateSettings?: (settings: RuntimeSettings) => void;
  env?: Record<string, string>;
}): RuntimeHomeFixture {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), options?.prefix || 'gantry-runtime-home-'),
  );
  const settings = createDefaultRuntimeSettings();
  options?.mutateSettings?.(settings);
  saveRuntimeSettings(runtimeHome, settings);
  const envPath = envFilePath(runtimeHome);
  if (options?.env && Object.keys(options.env).length > 0) {
    upsertEnvFile(envPath, options.env);
  }

  return {
    runtimeHome,
    envPath,
    settingsPath: path.join(runtimeHome, 'settings.yaml'),
    writeEnv(updates) {
      upsertEnvFile(envPath, updates);
    },
    cleanup() {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    },
  };
}
