import { describe, it, expect } from 'vitest';
import {
  IPC_TRANSPORT,
  ipcSocketPathFor,
  IPC_FRAME_MAX_BYTES,
  IPC_HEARTBEAT_INTERVAL_MS,
  IPC_EVENT_PIPE_DEBOUNCE_MS,
} from '@core/config/index.js';
describe('ipc transport config', () => {
  it('defaults to socket', () => expect(IPC_TRANSPORT).toBe('socket'));
  it('frame max defaults to 1 MiB', () =>
    expect(IPC_FRAME_MAX_BYTES).toBe(1024 * 1024));
  it('heartbeat has a sane default', () => {
    expect(IPC_HEARTBEAT_INTERVAL_MS).toBe(10000);
  });
  it('wakes event-pipe messages immediately by default', () =>
    expect(IPC_EVENT_PIPE_DEBOUNCE_MS).toBe(0));
  it('derives a socket path under the ipc dir', () =>
    expect(ipcSocketPathFor('/data/ipc')).toBe('/data/ipc/core.sock'));
});
