import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const BOONDI_DOMAIN_SKILL_IDS = [
  'boondi-gifting',
  'boondi-product-care',
  'boondi-orders',
  'boondi-store-aggregator',
  'boondi-misc-policy',
] as const;

function repoPath(...segments: string[]): string {
  return path.join(process.cwd(), ...segments);
}

function readSkill(skillId: string): string {
  return fs.readFileSync(
    repoPath('agents', 'boondi_support', 'skills', skillId, 'SKILL.md'),
    'utf-8',
  );
}

function frontmatterValue(markdown: string, key: string): string | undefined {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? '';
  const line = frontmatter
    .split('\n')
    .find((candidate) => candidate.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim();
}

describe('Boondi domain SDK skills', () => {
  it('ships each domain as a real eager skill folder', () => {
    for (const skillId of BOONDI_DOMAIN_SKILL_IDS) {
      const skillPath = repoPath(
        'agents',
        'boondi_support',
        'skills',
        skillId,
        'SKILL.md',
      );
      expect(fs.existsSync(skillPath), `${skillId} missing SKILL.md`).toBe(
        true,
      );

      const markdown = readSkill(skillId);
      expect(frontmatterValue(markdown, 'name')).toBe(skillId);
      expect(frontmatterValue(markdown, 'disclosure')).toBeUndefined();
      expect(frontmatterValue(markdown, 'user_invocable')).toBe('false');
      expect(
        frontmatterValue(markdown, 'description')?.length ?? 0,
      ).toBeLessThanOrEqual(320);
      expect(markdown).not.toMatch(
        /Status:|Scope:|Source Scenarios|Template_BA|TO BE FILLED/,
      );
    }
  });
});
