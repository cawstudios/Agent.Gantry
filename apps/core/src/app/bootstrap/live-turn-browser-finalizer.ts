import { resolveConversationBrowserProfile } from '../../shared/browser-profile-scope.js';
import { parseThreadQueueKey } from '../../shared/thread-queue-key.js';
import { getProfile } from '../../runtime/browser-profiles.js';
import {
  consumeBrowserProfileActivity,
  isBrowserProfileSyncEnabled,
  snapshotBrowserProfile,
} from '../../runtime/browser-profile-sync.js';

type WarnLog = (context: Record<string, unknown>, message: string) => void;

export interface LiveTurnBrowserFinalizer {
  (input: {
    queueJid: string;
    runId?: string | null;
    fencingVersion?: number;
  }): Promise<void>;
}

export function buildLiveTurnBrowserFinalizer(deps: {
  getConversationRoutes: () => Record<string, { folder: string }>;
  closeBrowserSession?: (profileName: string) => Promise<unknown>;
  closeBrowserToolBackends?: (profileName: string) => Promise<void>;
  warn: WarnLog;
}): LiveTurnBrowserFinalizer {
  return async (input) => {
    const { chatJid } = parseThreadQueueKey(input.queueJid);
    const folder = deps.getConversationRoutes()[chatJid]?.folder;
    if (!folder) return;
    const profileName = resolveConversationBrowserProfile({
      agentId: folder,
      workspaceKey: folder,
      conversationId: chatJid,
    });
    const used = consumeBrowserProfileActivity(profileName);
    if (!used) return;
    try {
      if (!isBrowserProfileSyncEnabled()) return;
      await deps.closeBrowserToolBackends?.(profileName);
      await deps.closeBrowserSession?.(profileName);
      const profile = getProfile(profileName);
      if (!profile) return;
      await snapshotBrowserProfile({
        profileName,
        profileDir: profile.dir,
        userDataDir: profile.userDataDir,
        snapshotRunId: input.runId ?? null,
        snapshotFencingVersion: input.fencingVersion ?? 0,
      });
    } catch (err) {
      deps.warn(
        { err, queueJid: input.queueJid, profileName },
        'Failed to snapshot live-turn browser profile after finalize',
      );
    }
  };
}
