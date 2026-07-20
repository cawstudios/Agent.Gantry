import { MAX_WORKSPACE_FOLDER_LENGTH } from '../shared/workspace-folder-policy.js';

export { MAX_WORKSPACE_FOLDER_LENGTH };

const WORKSPACE_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RESERVED_FOLDERS = new Set(['global', 'shared']);

export function isValidWorkspaceFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (folder.length > MAX_WORKSPACE_FOLDER_LENGTH) return false;
  if (!WORKSPACE_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}
