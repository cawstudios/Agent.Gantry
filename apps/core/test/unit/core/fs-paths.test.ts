import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { writeFileAtomic } from '@core/infrastructure/filesystem/paths.js';

describe('fs-path helpers', () => {
  it('uses restrictive default permissions for atomic writes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-fs-paths-'));
    try {
      const filePath = path.join(tmpDir, 'secret.json');
      writeFileAtomic(filePath, '{"secret":true}');
      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
