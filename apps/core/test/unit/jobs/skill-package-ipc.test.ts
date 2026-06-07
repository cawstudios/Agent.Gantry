import { describe, expect, it } from 'vitest';

import { parseSkillPackageAssets } from '@core/jobs/skill-package-ipc.js';

describe('parseSkillPackageAssets', () => {
  it('accepts large SKILL.md content and keeps approval preview bounded', () => {
    const body = 'Use this skill safely.\n'.repeat(350);
    const parsed = parseSkillPackageAssets([
      {
        path: 'SKILL.md',
        content: [
          '---',
          'name: Large Skill',
          'description: Large reviewed skill',
          '---',
          '# Large Skill',
          body,
        ].join('\n'),
      },
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skillMarkdownPreview.truncated).toBe(true);
    expect(parsed.skillMarkdownPreview.content.length).toBe(4000);
    expect(parsed.fileSummaries[0]).toEqual(
      expect.objectContaining({
        path: 'SKILL.md',
        sizeBytes: expect.any(Number),
        fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    );
  });

  it('rejects SKILL.md content too large for same-channel review delivery', () => {
    const parsed = parseSkillPackageAssets([
      {
        path: 'SKILL.md',
        content: [
          '---',
          'name: Too Large',
          'description: Too large for same-channel review',
          '---',
          '# Too Large',
          'x'.repeat(90_001),
        ].join('\n'),
      },
    ]);

    expect(parsed).toEqual({
      ok: false,
      error:
        'Skill package SKILL.md is too large for same-channel review. Keep SKILL.md under 90,000 characters and move long references into bundled resource files.',
    });
  });
});
