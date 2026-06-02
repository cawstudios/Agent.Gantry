import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from '../platform/group-folder.js';
import {
  PromptProfileService,
  DEFAULT_PROMPT_PROFILE_APP_ID,
  promptProfileAgentIdForFolder,
} from '../application/agents/prompt-profile-service.js';
import { syncAuthoredPromptFiles } from '../application/agents/authored-prompt-sync.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import { logger as defaultLogger } from '../infrastructure/logging/logger.js';
import { clearCachedSystemPrompt } from './prompt-cache.js';

type BootSyncLogger = Pick<typeof defaultLogger, 'info' | 'warn'>;

/**
 * Boot-time sync of each configured agent's authored SOUL.md / CLAUDE.md into
 * the prompt-profile artifact store. Source of truth = the on-disk files;
 * Postgres is a write-on-change, versioned replica that the per-spawn
 * compileSystemPrompt reads. Must run AFTER desired-state reconcile, which
 * ensures the agent rows the artifacts FK to. A present-but-empty SOUL/CLAUDE
 * throws EmptyAuthoredPromptFileError and aborts startup (fail-loud).
 */
export async function syncAuthoredPromptsAtBoot(input: {
  agents: Record<string, { name?: string }>;
  getFileArtifactStore: () => FileArtifactStore | undefined;
  logger?: BootSyncLogger;
}): Promise<void> {
  const log = input.logger ?? defaultLogger;
  const service = new PromptProfileService({
    fileArtifactStore: input.getFileArtifactStore,
  });

  for (const [folder, agent] of Object.entries(input.agents)) {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(folder);
    } catch (err) {
      log.warn(
        { err, folder },
        'Skipping authored-prompt sync for invalid agent folder',
      );
      continue;
    }

    const results = await syncAuthoredPromptFiles({
      agentFolder: folder,
      agentName: agent.name ?? folder,
      appId: DEFAULT_PROMPT_PROFILE_APP_ID,
      agentId: promptProfileAgentIdForFolder(folder),
      service,
      read: (fileName) => {
        const filePath = path.join(groupDir, fileName);
        if (!fs.existsSync(filePath)) return { exists: false, content: '' };
        return { exists: true, content: fs.readFileSync(filePath, 'utf8') };
      },
    });

    const synced = results.filter((r) => r.action === 'synced');
    if (synced.length > 0) {
      log.info(
        { folder, synced: synced.map((r) => `${r.fileName}@v${r.version}`) },
        'Synced authored prompt files into prompt profile',
      );
    }
  }

  // Drop any in-process compiled-prompt cache so it can never outlive a re-sync.
  // A no-op at boot (the cache is empty), but it keeps this function correct if it
  // is ever re-invoked in-process (e.g. on a settings reload) after the authored
  // files change underneath the cache.
  clearCachedSystemPrompt();
}
