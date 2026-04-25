import {
  RuntimeSettings,
  loadRuntimeSettings,
} from '../../config/settings/runtime-settings.js';
import { MYCLAW_HOME } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ensureRuntimeLayoutDirectories } from '../../platform/runtime-layout.js';
import { ensurePromptProfileBootstrapped } from '../../runtime/prompt-profile.js';
import { restoreRemoteControl } from '../../runtime/remote-control.js';
import { initializeRuntimeStorage } from '../../infrastructure/postgres/runtime-store.js';
import { RuntimeApp } from './runtime-app.js';

interface StartupDeps {
  ensureRuntimeLayoutDirectories: typeof ensureRuntimeLayoutDirectories;
  ensurePromptProfileBootstrapped: typeof ensurePromptProfileBootstrapped;
  initializeRuntimeStorage: typeof initializeRuntimeStorage;
  loadRuntimeSettings: typeof loadRuntimeSettings;
  restoreRemoteControl: typeof restoreRemoteControl;
  logger: Pick<typeof logger, 'info' | 'warn'>;
}

export interface StartupResult {
  runtimeSettings: RuntimeSettings;
}

function makeDefaultDeps(): StartupDeps {
  return {
    ensureRuntimeLayoutDirectories,
    ensurePromptProfileBootstrapped,
    initializeRuntimeStorage,
    loadRuntimeSettings,
    restoreRemoteControl,
    logger,
  };
}

export async function runStartup(
  app: RuntimeApp,
  deps: Partial<StartupDeps> = {},
): Promise<StartupResult> {
  const resolved: StartupDeps = {
    ...makeDefaultDeps(),
    ...deps,
  };

  resolved.ensureRuntimeLayoutDirectories(MYCLAW_HOME);
  try {
    resolved.ensurePromptProfileBootstrapped();
  } catch (err) {
    resolved.logger.warn(
      { err },
      'Failed to seed prompt profile files; continuing startup',
    );
  }

  const runtimeSettings = resolved.loadRuntimeSettings(MYCLAW_HOME);
  await resolved.initializeRuntimeStorage();
  resolved.logger.info('Database initialized');
  await app.loadState();
  app.ensureOneCLIAgentsForRegisteredGroups();

  resolved.restoreRemoteControl();

  return {
    runtimeSettings,
  };
}
