import path from 'path';
import { fileURLToPath } from 'url';

import { resolvePackageRootFromSourceDir } from '../platform/package-root.js';
import { ensurePrivateDirSync } from '../shared/private-fs.js';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const IPC_GROUP_SUBDIRS = [] as const;

export function getHostAgentRunnerDistDir(): string {
  const packageRoot = resolvePackageRootFromSourceDir(SOURCE_DIR);
  return path.join(packageRoot, 'dist', 'runner');
}

export function ensureGroupIpcLayout(groupIpcDir: string): void {
  ensurePrivateDirSync(groupIpcDir);
}
