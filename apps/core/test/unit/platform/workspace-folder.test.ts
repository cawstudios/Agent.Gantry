import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  isValidWorkspaceFolder,
  resolveWorkspaceFolderPath,
  resolveWorkspaceIpcPath,
} from '@core/platform/workspace-folder.js';
import { MAX_WORKSPACE_FOLDER_LENGTH } from '@core/platform/workspace-folder-rules.js';

describe('workspace folder validation', () => {
  it('accepts normal workspace folder names', () => {
    expect(isValidWorkspaceFolder('main')).toBe(true);
    expect(isValidWorkspaceFolder('family-chat')).toBe(true);
    expect(isValidWorkspaceFolder('Team_42')).toBe(true);
  });

  it('accepts exactly 64 characters and rejects longer folders', () => {
    expect(
      isValidWorkspaceFolder('a'.repeat(MAX_WORKSPACE_FOLDER_LENGTH)),
    ).toBe(true);
    expect(
      isValidWorkspaceFolder('a'.repeat(MAX_WORKSPACE_FOLDER_LENGTH + 1)),
    ).toBe(false);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidWorkspaceFolder('../../etc')).toBe(false);
    expect(isValidWorkspaceFolder('/tmp')).toBe(false);
    expect(isValidWorkspaceFolder('global')).toBe(false);
    expect(isValidWorkspaceFolder('shared')).toBe(false);
    expect(isValidWorkspaceFolder('')).toBe(false);
  });

  it('resolves safe paths under agents directory', () => {
    const resolved = resolveWorkspaceFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}agents${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveWorkspaceIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveWorkspaceFolderPath('../../etc')).toThrow();
    expect(() => resolveWorkspaceIpcPath('/tmp')).toThrow();
  });
});
