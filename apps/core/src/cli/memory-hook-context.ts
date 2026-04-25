import fs from 'fs';
import path from 'path';

import { logger } from '../infrastructure/logging/logger.js';
import { getAgentDir, getClaudeProjectDirName } from '../shared/myclaw-home.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';

export type HookPayload = {
  session_id?: string;
  sessionId?: string;
  user_id?: string;
  userId?: string;
  transcript_path?: string;
  transcriptPath?: string;
  cwd?: string;
  hook_event_name?: string;
  hookEventName?: string;
};

function isSafeSessionId(sessionId: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sessionId)) return false;
  if (sessionId.includes('..')) return false;
  return true;
}

function normalizePath(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return path.resolve(trimmed);
}

function isWithin(rootDir: string, candidatePath: string): boolean {
  const rel = path.relative(rootDir, candidatePath);
  return !(rel.startsWith('..') || path.isAbsolute(rel));
}

function resolveRuntimeAndGroupFromProjectDir(projectDirRaw?: string): {
  runtimeHome?: string;
  groupFolder?: string;
} {
  const projectDir = normalizePath(projectDirRaw);
  if (!projectDir) return {};

  const marker = `${path.sep}data${path.sep}sessions${path.sep}`;
  const markerIndex = projectDir.lastIndexOf(marker);
  if (markerIndex === -1) return {};

  const runtimeHome = projectDir.slice(0, markerIndex) || undefined;
  const remainder = projectDir.slice(markerIndex + marker.length);
  const [groupFolder] = remainder.split(path.sep).filter(Boolean);

  return {
    runtimeHome,
    groupFolder:
      groupFolder && isValidGroupFolder(groupFolder) ? groupFolder : undefined,
  };
}

function resolveRuntimeAndGroupFromAgentDir(agentDirRaw?: string): {
  runtimeHome?: string;
  groupFolder?: string;
} {
  const agentDir = normalizePath(agentDirRaw);
  if (!agentDir) return {};

  const marker = `${path.sep}agents${path.sep}`;
  const markerIndex = agentDir.lastIndexOf(marker);
  if (markerIndex === -1) return {};

  const runtimeHome = agentDir.slice(0, markerIndex) || undefined;
  const remainder = agentDir.slice(markerIndex + marker.length);
  const [groupFolder] = remainder.split(path.sep).filter(Boolean);

  return {
    runtimeHome,
    groupFolder:
      groupFolder && isValidGroupFolder(groupFolder) ? groupFolder : undefined,
  };
}

export async function resolveRuntimeAndGroup(
  payload: HookPayload,
  env: NodeJS.ProcessEnv,
): Promise<{
  runtimeHome?: string;
  groupFolder?: string;
  projectDir?: string;
}> {
  const explicitGroup = env.MYCLAW_GROUP_FOLDER?.trim();
  const projectDir = normalizePath(env.CLAUDE_PROJECT_DIR);
  const fromProject = resolveRuntimeAndGroupFromProjectDir(projectDir);
  const hookCwd = normalizePath(payload.cwd) || normalizePath(env.PWD);
  const fromAgentDir = resolveRuntimeAndGroupFromAgentDir(
    hookCwd || process.cwd(),
  );
  const runtimeHome =
    env.MYCLAW_HOME?.trim() ||
    fromProject.runtimeHome ||
    fromAgentDir.runtimeHome ||
    undefined;

  let groupFolder: string | undefined;
  if (explicitGroup && isValidGroupFolder(explicitGroup)) {
    groupFolder = explicitGroup;
  } else if (fromProject.groupFolder) {
    groupFolder = fromProject.groupFolder;
  } else if (fromAgentDir.groupFolder) {
    groupFolder = fromAgentDir.groupFolder;
  }

  if (!groupFolder && runtimeHome && projectDir) {
    let db: Awaited<ReturnType<typeof openRuntimeGroupDb>> | null = null;
    try {
      db = await openRuntimeGroupDb(runtimeHome);
      const groups = Object.values(await db.getAllRegisteredGroups());
      const matched = groups.find((group) => {
        const groupProjectRoot = path.resolve(
          runtimeHome,
          'data',
          'sessions',
          group.folder,
        );
        return isWithin(groupProjectRoot, projectDir);
      });
      if (matched?.folder && isValidGroupFolder(matched.folder)) {
        groupFolder = matched.folder;
      }
    } catch (err) {
      logger.debug({ err }, 'Failed runtime group DB lookup for memory-hook');
    } finally {
      if (db) {
        await db.close();
      }
    }
  }

  return {
    runtimeHome,
    groupFolder,
    projectDir,
  };
}

export function resolveSessionId(
  payload: HookPayload,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const raw =
    payload.session_id ||
    payload.sessionId ||
    env.CLAUDE_SESSION_ID ||
    undefined;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export function resolveUserId(
  payload: HookPayload,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const raw =
    payload.user_id ||
    payload.userId ||
    env.MYCLAW_USER_ID ||
    env.CLAUDE_USER_ID ||
    undefined;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export function resolveTranscriptPath(
  payload: HookPayload,
  runtimeHome: string | undefined,
  groupFolder: string,
  sessionId: string | undefined,
): string | undefined {
  if (!runtimeHome || !sessionId || !isSafeSessionId(sessionId)) {
    return undefined;
  }

  const projectsRoot = path.resolve(
    runtimeHome,
    'data',
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );
  const validateCandidate = (candidatePath: string): string | undefined => {
    if (!fs.existsSync(candidatePath)) return undefined;
    const baseName = path.basename(candidatePath);
    if (!baseName.endsWith('.jsonl')) return undefined;
    if (baseName !== `${sessionId}.jsonl`) return undefined;

    let resolvedTranscript: string;
    let resolvedRoot: string;
    try {
      resolvedTranscript = fs.realpathSync(candidatePath);
      resolvedRoot = fs.realpathSync(projectsRoot);
    } catch {
      return undefined;
    }
    return isWithin(resolvedRoot, resolvedTranscript)
      ? resolvedTranscript
      : undefined;
  };

  const raw = payload.transcript_path || payload.transcriptPath;
  const provided = normalizePath(raw);
  if (provided) {
    const validated = validateCandidate(provided);
    if (validated) return validated;
  }

  if (!fs.existsSync(projectsRoot)) {
    return undefined;
  }
  const expectedPath = path.join(
    projectsRoot,
    getClaudeProjectDirName(getAgentDir(groupFolder, runtimeHome)),
    `${sessionId}.jsonl`,
  );
  const expectedValidated = validateCandidate(expectedPath);
  if (expectedValidated) return expectedValidated;

  const stack = [projectsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== `${sessionId}.jsonl`) continue;
      const validated = validateCandidate(fullPath);
      if (validated) return validated;
    }
  }

  return undefined;
}
