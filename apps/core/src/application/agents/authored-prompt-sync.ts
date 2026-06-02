import { promptProfileAgentIdForFolder } from './prompt-profile-service.js';

export class EmptyAuthoredPromptFileError extends Error {
  constructor(
    public readonly agentFolder: string,
    public readonly fileName: string,
  ) {
    super(
      `Authored prompt file ${agentFolder}/${fileName} is present but empty; refusing to start.`,
    );
    this.name = 'EmptyAuthoredPromptFileError';
  }
}

export interface AuthoredFileSnapshot {
  exists: boolean;
  content: string;
}

/** Reads an authored file by bare name (e.g. "SOUL.md") for one agent folder. */
export type AuthoredFileReader = (fileName: string) => AuthoredFileSnapshot;

/** Minimal slice of PromptProfileService this module needs (keeps tests light). */
export interface AuthoredPromptSink {
  syncAuthoredArtifact(input: {
    appId: string;
    agentId: string;
    virtualPath: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ changed: boolean; version: number | null }>;
  ensureAgentDefaults(input: {
    agentFolder: string;
    agentName: string;
  }): Promise<void>;
}

interface AuthoredTarget {
  fileName: 'SOUL.md' | 'CLAUDE.md';
  kind: 'soul' | 'group-context';
}

const AUTHORED_TARGETS: AuthoredTarget[] = [
  { fileName: 'SOUL.md', kind: 'soul' },
  { fileName: 'CLAUDE.md', kind: 'group-context' },
];

export interface AuthoredSyncResult {
  fileName: string;
  virtualPath: string;
  action: 'synced' | 'unchanged';
  version: number | null;
}

/**
 * Apply the authored-prompt decision rules for one agent folder:
 *  - present + non-empty  -> write-on-change sync
 *  - present + empty       -> throw EmptyAuthoredPromptFileError (fail boot)
 *  - absent                -> fall back to generic defaults (once)
 */
export async function syncAuthoredPromptFiles(input: {
  agentFolder: string;
  agentName: string;
  appId: string;
  agentId: string;
  service: AuthoredPromptSink;
  read: AuthoredFileReader;
}): Promise<AuthoredSyncResult[]> {
  const agentId =
    input.agentId || promptProfileAgentIdForFolder(input.agentFolder);
  const results: AuthoredSyncResult[] = [];
  let anyMissing = false;

  // Read every target up front and fail-loud on ANY present-but-empty file BEFORE
  // writing anything. Fail-loud must be all-or-nothing: an empty CLAUDE.md must
  // never leave a half-written SOUL.md (or vice-versa), regardless of order.
  const snapshots = AUTHORED_TARGETS.map((target) => ({
    target,
    snapshot: input.read(target.fileName),
  }));
  for (const { target, snapshot } of snapshots) {
    if (snapshot.exists && snapshot.content.trim().length === 0) {
      throw new EmptyAuthoredPromptFileError(input.agentFolder, target.fileName);
    }
  }

  for (const { target, snapshot } of snapshots) {
    if (!snapshot.exists) {
      anyMissing = true;
      continue;
    }
    const virtualPath = `${input.agentFolder}/${target.fileName}`;
    const { changed, version } = await input.service.syncAuthoredArtifact({
      appId: input.appId,
      agentId,
      virtualPath,
      content: snapshot.content,
      metadata: { promptProfileKind: target.kind, source: 'authored-file' },
    });
    results.push({
      fileName: target.fileName,
      virtualPath,
      action: changed ? 'synced' : 'unchanged',
      version,
    });
  }

  if (anyMissing) {
    await input.service.ensureAgentDefaults({
      agentFolder: input.agentFolder,
      agentName: input.agentName,
    });
  }

  return results;
}
