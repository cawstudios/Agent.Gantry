import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PROFILE_MIRROR_HEADER,
  readProfileFileMirror,
  profileMirrorPath,
  stripProfileMirrorHeader,
  writeProfileFileMirror,
} from '@core/platform/profile-file-mirror.js';

describe('profile file mirror', () => {
  const tempDirs: string[] = [];

  function makeRuntimeHome(): string {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-mirror-'),
    );
    tempDirs.push(runtimeHome);
    return runtimeHome;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips a leading managed header (and the blank line after it)', () => {
    const body = '# Soul\n\nBe sharp.';
    const mirrored = `${PROFILE_MIRROR_HEADER}\n\n${body}`;
    expect(stripProfileMirrorHeader(mirrored)).toBe(body);
  });

  it('leaves content without the header untouched', () => {
    const body = 'no header here';
    expect(stripProfileMirrorHeader(body)).toBe(body);
  });

  it('prepends the header and stays idempotent across re-writes', async () => {
    const runtimeHome = makeRuntimeHome();
    const agentFolder = 'mirror_test_agent';
    await writeProfileFileMirror({
      runtimeHome,
      agentFolder,
      fileName: 'AGENTS.md',
      content: '# How I work',
    });
    const first = readProfileFileMirror({
      runtimeHome,
      agentFolder,
      fileName: 'AGENTS.md',
    });
    expect(first?.startsWith(PROFILE_MIRROR_HEADER)).toBe(true);
    expect(stripProfileMirrorHeader(first ?? '')).toBe('# How I work');

    // Re-mirroring a file that already carries the header must not double it.
    await writeProfileFileMirror({
      runtimeHome,
      agentFolder,
      fileName: 'AGENTS.md',
      content: first ?? '',
    });
    const second = readProfileFileMirror({
      runtimeHome,
      agentFolder,
      fileName: 'AGENTS.md',
    });
    expect(second).toBe(first);
    expect((second ?? '').split(PROFILE_MIRROR_HEADER).length - 1).toBe(1);
  });

  it('writes mirrors under the selected runtime home', async () => {
    const runtimeHome = makeRuntimeHome();
    await writeProfileFileMirror({
      runtimeHome,
      agentFolder: 'scoped_agent',
      fileName: 'SOUL.md',
      content: '# Scoped soul',
    });

    const targetPath = profileMirrorPath('scoped_agent', 'SOUL.md', {
      runtimeHome,
    });
    expect(targetPath).toBe(
      path.join(runtimeHome, 'agents', 'scoped_agent', 'SOUL.md'),
    );
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(
      stripProfileMirrorHeader(
        readProfileFileMirror({
          runtimeHome,
          agentFolder: 'scoped_agent',
          fileName: 'SOUL.md',
        }) ?? '',
      ),
    ).toBe('# Scoped soul');
  });

  it('uses a non-reserved mirror file name for AGENTS.md', async () => {
    const runtimeHome = makeRuntimeHome();
    await writeProfileFileMirror({
      runtimeHome,
      agentFolder: 'reserved_agent',
      fileName: 'AGENTS.md',
      content: '# Reviewed instructions',
    });

    expect(
      fs.existsSync(
        path.join(runtimeHome, 'agents', 'reserved_agent', 'AGENTS.md'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(runtimeHome, 'agents', 'reserved_agent', 'AGENTS.profile.md'),
      ),
    ).toBe(true);
  });

  it('rejects symlinked agent mirror directories', async () => {
    const runtimeHome = makeRuntimeHome();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-outside-'));
    tempDirs.push(outside);
    fs.mkdirSync(path.join(runtimeHome, 'agents'), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(runtimeHome, 'agents', 'linked_agent'));
    } catch {
      return;
    }

    await expect(
      writeProfileFileMirror({
        runtimeHome,
        agentFolder: 'linked_agent',
        fileName: 'AGENTS.md',
        content: '# unsafe',
      }),
    ).rejects.toThrow('not a safe directory');
  });
});
