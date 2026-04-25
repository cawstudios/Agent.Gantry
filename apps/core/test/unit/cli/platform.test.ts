import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileSync = vi.fn();
const mockSpawnSync = vi.fn();
const mockPlatform = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

vi.mock('os', () => ({
  default: {
    platform: (...args: unknown[]) => mockPlatform(...args),
  },
}));

describe('cli/platform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue('');
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockPlatform.mockReturnValue('linux');
  });

  it('detectPlatform maps win32 to windows', async () => {
    mockPlatform.mockReturnValue('win32');
    const mod = await import('@core/infrastructure/service/platform.js');
    expect(mod.detectPlatform()).toBe('windows');
  });

  it('commandExists uses where on windows', async () => {
    mockPlatform.mockReturnValue('win32');
    const mod = await import('@core/infrastructure/service/platform.js');
    expect(mod.commandExists('node')).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith('where', ['node'], {
      stdio: 'ignore',
    });
  });

  it('commandExists uses which on non-windows hosts', async () => {
    mockPlatform.mockReturnValue('linux');
    const mod = await import('@core/infrastructure/service/platform.js');
    expect(mod.commandExists('node')).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith('which', ['node'], {
      stdio: 'ignore',
    });
  });

  it('commandExists returns false when command lookup fails', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const mod = await import('@core/infrastructure/service/platform.js');
    expect(mod.commandExists('missing-bin')).toBe(false);
  });

  it('tryExec maps spawn status and output', async () => {
    mockSpawnSync.mockReturnValue({
      status: 7,
      stdout: 'out',
      stderr: 'err',
    });
    const mod = await import('@core/infrastructure/service/platform.js');

    expect(mod.tryExec('docker', ['info'])).toEqual({
      ok: false,
      stdout: 'out',
      stderr: 'err',
    });
    expect(mockSpawnSync).toHaveBeenCalledWith('docker', ['info'], {
      encoding: 'utf-8',
      input: undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('tryExec forwards stdin through a pipe when input is provided', async () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'ok',
      stderr: '',
    });
    const mod = await import('@core/infrastructure/service/platform.js');

    expect(
      mod.tryExec('docker', ['exec', '-i'], { input: 'select 1' }),
    ).toEqual({
      ok: true,
      stdout: 'ok',
      stderr: '',
    });
    expect(mockSpawnSync).toHaveBeenCalledWith('docker', ['exec', '-i'], {
      encoding: 'utf-8',
      input: 'select 1',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });
});
