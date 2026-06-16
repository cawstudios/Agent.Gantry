export const IPC_WIRE_VERSION = 1 as const;

export type IpcWireType = 'req' | 'resp' | 'push' | 'ctrl';

export type IpcWireChannel =
  | 'task'
  | 'memory'
  | 'browser'
  | 'permission'
  | 'user_question'
  | 'message'
  | 'continuation'
  | 'close'
  | 'bind'
  | 'live_tool_rules'
  | 'interaction_boundary';

export type IpcCtrl =
  | 'hello'
  | 'welcome'
  | 'ping'
  | 'pong'
  | 'drain'
  | 'busy'
  | 'close';

export interface IpcWireFrame {
  v: 1;
  type: IpcWireType;
  channel: IpcWireChannel | null;
  ctrl?: IpcCtrl | null;
  id: string;
  payload: Record<string, unknown>;
}

export class IpcWireError extends Error {
  constructor(public readonly reason: string) {
    super(`IPC wire error: ${reason}`);
    this.name = 'IpcWireError';
  }
}

const WIRE_TYPES: readonly IpcWireType[] = ['req', 'resp', 'push', 'ctrl'];
const WIRE_CHANNELS: readonly IpcWireChannel[] = [
  'task',
  'memory',
  'browser',
  'permission',
  'user_question',
  'message',
  'continuation',
  'close',
  'bind',
  'live_tool_rules',
  'interaction_boundary',
];
const CTRL_VALUES: readonly IpcCtrl[] = [
  'hello',
  'welcome',
  'ping',
  'pong',
  'drain',
  'busy',
  'close',
];

export function isIpcWireType(x: unknown): x is IpcWireType {
  return typeof x === 'string' && (WIRE_TYPES as readonly string[]).includes(x);
}

export function isIpcWireChannel(x: unknown): x is IpcWireChannel {
  return (
    typeof x === 'string' && (WIRE_CHANNELS as readonly string[]).includes(x)
  );
}

export function encodeWireFrame(f: IpcWireFrame): string {
  // Stable field order: v, type, channel, ctrl (only when non-null/defined), id, payload
  const obj: Record<string, unknown> = {
    v: f.v,
    type: f.type,
    channel: f.channel,
  };
  if (f.ctrl != null) {
    obj.ctrl = f.ctrl;
  }
  obj.id = f.id;
  obj.payload = f.payload;
  return JSON.stringify(obj);
}

export function parseWireFrame(
  raw: string | Record<string, unknown>,
): IpcWireFrame {
  let obj: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new IpcWireError('malformed_json');
    }
  } else {
    obj = raw;
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new IpcWireError('bad_version');
  }

  if (obj['v'] !== 1) {
    throw new IpcWireError('bad_version');
  }

  const type = obj['type'];
  if (!isIpcWireType(type)) {
    throw new IpcWireError('bad_type');
  }

  const id = obj['id'];
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new IpcWireError('bad_id');
  }

  const payload = obj['payload'];
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new IpcWireError('bad_payload');
  }

  // channel validation
  let channel: IpcWireChannel | null;
  if (type === 'ctrl') {
    // ctrl frames: channel may be null/absent
    const rawChannel = obj['channel'];
    if (rawChannel == null) {
      channel = null;
    } else if (isIpcWireChannel(rawChannel)) {
      channel = rawChannel;
    } else {
      throw new IpcWireError('bad_channel');
    }
    // validate ctrl field if present
    const rawCtrl = obj['ctrl'];
    if (rawCtrl != null) {
      if (!(CTRL_VALUES as readonly unknown[]).includes(rawCtrl)) {
        throw new IpcWireError('bad_ctrl');
      }
    }
    const ctrl = rawCtrl != null ? (rawCtrl as IpcCtrl) : undefined;
    const frame: IpcWireFrame = {
      v: 1,
      type,
      channel,
      id,
      payload: payload as Record<string, unknown>,
    };
    if (ctrl != null) {
      frame.ctrl = ctrl;
    }
    return frame;
  } else {
    // non-ctrl frames: channel must be a valid IpcWireChannel
    const rawChannel = obj['channel'];
    if (!isIpcWireChannel(rawChannel)) {
      throw new IpcWireError('bad_channel');
    }
    channel = rawChannel;
    return {
      v: 1,
      type,
      channel,
      id,
      payload: payload as Record<string, unknown>,
    };
  }
}
