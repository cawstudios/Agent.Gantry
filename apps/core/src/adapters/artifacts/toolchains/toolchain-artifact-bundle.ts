import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ToolchainArtifactFile } from '../../../domain/ports/toolchain-artifact-store.js';

/**
 * Toolchain artifacts are a flat, content-addressed file set (node_modules +
 * lockfile + package.json). Unlike skill bundles they carry no required marker
 * file (no SKILL.md), so they get their own normalize/hash here rather than
 * reusing the skill bundle helpers, while keeping the identical
 * `sha256(path \0 content \0 ...)` content-hash shape so a worker can verify a
 * fetched artifact against the recorded hash.
 */
export function normalizeToolchainFiles(
  files: ToolchainArtifactFile[],
): ToolchainArtifactFile[] {
  return files
    .map((file) => ({
      path: normalizeToolchainPath(file.path),
      content: new Uint8Array(file.content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function hashToolchainFiles(files: ToolchainArtifactFile[]): string {
  const hash = createHash('sha256');
  for (const file of normalizeToolchainFiles(files)) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function normalizeToolchainPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    path.posix.isAbsolute(normalized) ||
    parts.some((part) => part === '..' || part === '.' || part === '')
  ) {
    throw new Error(`Invalid toolchain artifact path: ${value}`);
  }
  return parts.join('/');
}

export function normalizeToolchainStorageRef(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    path.posix.isAbsolute(normalized) ||
    parts.some((part) => part === '..' || part === '.' || part === '')
  ) {
    throw new Error(`Invalid toolchain artifact storage ref: ${value}`);
  }
  return parts.join('/');
}

/** Content-addressed prefix for a manifest: `toolchains/<sanitized-hash>`. */
export function toolchainStorageRefFor(manifestHash: string): string {
  const sanitized = manifestHash
    .replace(/^sha256:/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  if (!sanitized) {
    throw new Error(`Invalid toolchain manifest hash: ${manifestHash}`);
  }
  return path.posix.join('toolchains', sanitized);
}

export function resolveToolchainAssetPath(
  root: string,
  assetPath: string,
): string {
  const relative = normalizeToolchainPath(assetPath);
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, ...relative.split('/'));
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Invalid toolchain artifact path: ${assetPath}`);
  }
  return target;
}
