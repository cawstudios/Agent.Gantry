import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  new URL('../../../../..', import.meta.url).pathname,
);

function collectFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(absolute));
      continue;
    }
    out.push(absolute);
  }
  return out;
}

describe('memory legacy read surface cleanup', () => {
  it('keeps runtime memory hydration off the legacy MemoryRepository list API', () => {
    const sourceRoot = path.join(repoRoot, 'apps/core/src');
    const offenders: string[] = [];

    for (const absolutePath of collectFiles(sourceRoot)) {
      if (!absolutePath.endsWith('.ts')) continue;
      const relativePath = path.relative(repoRoot, absolutePath);
      const source = fs.readFileSync(absolutePath, 'utf8');
      if (
        source.includes('SearchMemoryUseCase') ||
        source.includes('listMemoryItems')
      ) {
        offenders.push(relativePath);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('does not retain the legacy personal-agent subject default in active memory code', () => {
    const sourceRoots = [
      path.join(repoRoot, 'apps/core/src/memory'),
      path.join(repoRoot, 'apps/core/src/runtime'),
      path.join(repoRoot, 'apps/core/src/runner/mcp/tools'),
    ];
    const offenders: string[] = [];

    for (const sourceRoot of sourceRoots) {
      for (const absolutePath of collectFiles(sourceRoot)) {
        if (!absolutePath.endsWith('.ts')) continue;
        const relativePath = path.relative(repoRoot, absolutePath);
        const source = fs.readFileSync(absolutePath, 'utf8');
        if (
          source.includes('DEFAULT_MEMORY_AGENT_ID') ||
          source.includes("'agent:personal'") ||
          source.includes('"agent:personal"')
        ) {
          offenders.push(relativePath);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
