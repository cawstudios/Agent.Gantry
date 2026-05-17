import os from 'os';
import path from 'path';

const DEFAULT_GANTRY_HOME = path.join(os.homedir(), 'gantry');

function expandHomePath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function getGantryHome(raw?: string): string {
  const source =
    raw?.trim() || process.env.GANTRY_HOME?.trim() || DEFAULT_GANTRY_HOME;
  return path.resolve(expandHomePath(source));
}

export function getIpcDir(
  groupFolder: string,
  runtimeHome = getGantryHome(),
): string {
  return path.resolve(runtimeHome, 'data', 'ipc', groupFolder);
}

export function getAgentDir(
  groupFolder: string,
  runtimeHome = getGantryHome(),
): string {
  return path.resolve(runtimeHome, 'agents', groupFolder);
}

export function getClaudeProjectDirName(cwd: string): string {
  return path.resolve(cwd).replace(/[\\/:\s]/g, '-');
}
