import { execFileSync, spawnSync } from 'child_process';
import os from 'os';

export type HostPlatform = 'macos' | 'linux' | 'windows' | 'unknown';

export function detectPlatform(): HostPlatform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

export function commandExists(command: string): boolean {
  try {
    const detector = detectPlatform() === 'windows' ? 'where' : 'which';
    execFileSync(detector, [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function tryExec(
  command: string,
  args: string[],
  options: { input?: string } = {},
): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

export function getNodeVersion(): string {
  return process.version.replace(/^v/, '');
}

export function getNodeMajorVersion(): number {
  const raw = getNodeVersion().split('.')[0];
  const major = Number(raw);
  return Number.isFinite(major) ? major : 0;
}

export function hasSystemdUser(): boolean {
  if (detectPlatform() !== 'linux') return false;
  if (!commandExists('systemctl')) return false;
  return tryExec('systemctl', ['--user', 'show-environment']).ok;
}
