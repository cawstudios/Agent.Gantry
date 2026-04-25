import fs from 'fs';
import path from 'path';

import { nowMs } from '../time/datetime.js';

export function safeRealpathSync(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export function resolvePathWithRealParent(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  let existingParent = path.dirname(resolved);
  while (!fs.existsSync(existingParent)) {
    const parent = path.dirname(existingParent);
    if (parent === existingParent) break;
    existingParent = parent;
  }
  const parentReal = safeRealpathSync(existingParent);
  const tail = path.relative(existingParent, resolved);
  return path.resolve(parentReal, tail);
}

export function isPathInside(rootDir: string, candidatePath: string): boolean {
  const rootResolved = safeRealpathSync(rootDir);
  const candidateResolved = resolvePathWithRealParent(candidatePath);
  const relative = path.relative(rootResolved, candidateResolved);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function writeFileAtomic(
  filePath: string,
  content: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${nowMs()}.tmp`,
  );
  fs.writeFileSync(tmpPath, content, {
    mode: opts.mode ?? 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}
