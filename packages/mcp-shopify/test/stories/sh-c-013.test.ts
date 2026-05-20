import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';

describe('SH-C-013 return policy question (KB-only, no Shopify call)', () => {
  it('boondi-kb SKILL.md contains return policy section', async () => {
    const root = path.resolve(__dirname, '../../../..');
    const skillPath = path.join(root, '.claude/skills/boondi-kb/SKILL.md');
    const content = await fs.readFile(skillPath, 'utf8');
    expect(content.toLowerCase()).toContain('return policy');
  });
});
