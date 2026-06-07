import { describe, expect, it } from 'vitest';

import {
  isAgentProfileArtifactWrite,
  isProtectedFileArtifactVirtualPath,
  isProtectedProfileFileArtifactVirtualPath,
  PROMPT_PROFILE_VIRTUAL_SCOPE,
} from '@core/domain/file-artifacts/protected-virtual-path.js';
import { normalizeFileArtifactPath } from '@core/domain/file-artifacts/virtual-path.js';

describe('file artifact virtual paths', () => {
  it('allows protected hidden virtual paths while rejecting traversal', () => {
    expect(normalizeFileArtifactPath('.mcp.json')).toBe('.mcp.json');
    expect(normalizeFileArtifactPath('.codex/skills/review/SKILL.md')).toBe(
      '.codex/skills/review/SKILL.md',
    );
    expect(() => normalizeFileArtifactPath('../settings.yaml')).toThrow(
      /safe relative virtual path/,
    );
  });

  it('recognizes protected prompt and capability paths', () => {
    expect(isProtectedFileArtifactVirtualPath('agents/main/SOUL.md')).toBe(
      true,
    );
    expect(isProtectedFileArtifactVirtualPath('.mcp.json')).toBe(true);
    expect(
      isProtectedFileArtifactVirtualPath('.codex/skills/review/SKILL.md'),
    ).toBe(true);
    expect(isProtectedFileArtifactVirtualPath('notes/SOUL-notes.md')).toBe(
      false,
    );
  });

  it('does not broadly protect AGENTS.md by filename so ordinary artifacts are writable', () => {
    // AGENTS.md is a very common filename; it is only protected as an agent
    // profile artifact (prompt-profile scope), not by basename everywhere.
    expect(isProtectedFileArtifactVirtualPath('docs/AGENTS.md')).toBe(false);
    expect(isProtectedFileArtifactVirtualPath('agents/main/AGENTS.md')).toBe(
      false,
    );
  });

  it('flags profile artifact writes only in the prompt-profile scope', () => {
    expect(
      isAgentProfileArtifactWrite(
        PROMPT_PROFILE_VIRTUAL_SCOPE,
        'main/AGENTS.md',
      ),
    ).toBe(true);
    expect(
      isAgentProfileArtifactWrite(PROMPT_PROFILE_VIRTUAL_SCOPE, 'main/SOUL.md'),
    ).toBe(true);
    // Same filename in an ordinary scope is a normal artifact, not a profile.
    expect(isAgentProfileArtifactWrite('default', 'docs/AGENTS.md')).toBe(
      false,
    );
    expect(
      isAgentProfileArtifactWrite(
        PROMPT_PROFILE_VIRTUAL_SCOPE,
        'main/notes.md',
      ),
    ).toBe(false);
  });

  it('no longer treats the legacy CLAUDE.md profile name as protected', () => {
    expect(isProtectedFileArtifactVirtualPath('agents/main/CLAUDE.md')).toBe(
      false,
    );
  });

  it('identifies profile prose files distinctly from other protected paths', () => {
    expect(
      isProtectedProfileFileArtifactVirtualPath('agents/main/SOUL.md'),
    ).toBe(true);
    expect(
      isProtectedProfileFileArtifactVirtualPath('agents/main/AGENTS.md'),
    ).toBe(true);
    expect(isProtectedProfileFileArtifactVirtualPath('.mcp.json')).toBe(false);
    expect(
      isProtectedProfileFileArtifactVirtualPath(
        '.codex/skills/review/SKILL.md',
      ),
    ).toBe(false);
  });
});
