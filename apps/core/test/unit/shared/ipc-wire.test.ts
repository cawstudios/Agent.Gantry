import { describe, it, expect } from 'vitest';
import {
  encodeWireFrame,
  parseWireFrame,
  isIpcWireChannel,
  IpcWireError,
  type IpcWireFrame,
} from '@core/shared/ipc-wire.js';

const req: IpcWireFrame = {
  v: 1,
  type: 'req',
  channel: 'task',
  id: 'req-1',
  payload: { action: 'start' },
};
const resp: IpcWireFrame = {
  v: 1,
  type: 'resp',
  channel: 'task',
  id: 'resp-1',
  payload: { result: 'ok' },
};
const push: IpcWireFrame = {
  v: 1,
  type: 'push',
  channel: 'continuation',
  id: 'push-1',
  payload: { chunk: 'hello' },
};
const ctrl: IpcWireFrame = {
  v: 1,
  type: 'ctrl',
  channel: null,
  ctrl: 'hello',
  id: 'ctrl-1',
  payload: {},
};
// Continuation-push seam (Task A): the socket transport delivers continuation
// follow-ups and close signals as `type:'push'` frames on these channels. The
// continuation push carries the message text plus threadId/sequence metadata.
const continuationPush: IpcWireFrame = {
  v: 1,
  type: 'push',
  channel: 'continuation',
  id: 'cont-1',
  payload: { threadId: null, sequence: 0 },
};
const closePush: IpcWireFrame = {
  v: 1,
  type: 'push',
  channel: 'close',
  id: 'close-1',
  payload: { threadId: null },
};

describe('ipc-wire', () => {
  describe('round-trips', () => {
    it('req frame', () => {
      expect(parseWireFrame(encodeWireFrame(req))).toEqual(req);
    });
    it('resp frame', () => {
      expect(parseWireFrame(encodeWireFrame(resp))).toEqual(resp);
    });
    it('push frame', () => {
      expect(parseWireFrame(encodeWireFrame(push))).toEqual(push);
    });
    it('ctrl frame with ctrl field', () => {
      expect(parseWireFrame(encodeWireFrame(ctrl))).toEqual(ctrl);
    });
    it('push frame on the continuation channel (Task A seam)', () => {
      expect(parseWireFrame(encodeWireFrame(continuationPush))).toEqual(
        continuationPush,
      );
    });
    it('push frame on the close channel (Task A seam)', () => {
      expect(parseWireFrame(encodeWireFrame(closePush))).toEqual(closePush);
    });
  });

  describe('parseWireFrame error cases', () => {
    it('malformed JSON string => IpcWireError(malformed_json)', () => {
      const err = (() => {
        try {
          parseWireFrame('{bad json');
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(IpcWireError);
      expect((err as IpcWireError).reason).toBe('malformed_json');
    });

    it('v:2 => bad_version', () => {
      const raw = JSON.stringify({
        v: 2,
        type: 'req',
        channel: 'task',
        id: 'x',
        payload: {},
      });
      expect(() => parseWireFrame(raw)).toThrow(IpcWireError);
      const err = (() => {
        try {
          parseWireFrame(raw);
        } catch (e) {
          return e;
        }
      })();
      expect((err as IpcWireError).reason).toBe('bad_version');
    });

    it('unknown type => bad_type', () => {
      const raw = JSON.stringify({
        v: 1,
        type: 'foo',
        channel: 'task',
        id: 'x',
        payload: {},
      });
      const err = (() => {
        try {
          parseWireFrame(raw);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(IpcWireError);
      expect((err as IpcWireError).reason).toBe('bad_type');
    });

    it('unknown channel on req => bad_channel', () => {
      const raw = JSON.stringify({
        v: 1,
        type: 'req',
        channel: 'foo',
        id: 'x',
        payload: {},
      });
      const err = (() => {
        try {
          parseWireFrame(raw);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(IpcWireError);
      expect((err as IpcWireError).reason).toBe('bad_channel');
    });

    it('missing id => bad_id', () => {
      const raw = JSON.stringify({
        v: 1,
        type: 'req',
        channel: 'task',
        payload: {},
      });
      const err = (() => {
        try {
          parseWireFrame(raw);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(IpcWireError);
      expect((err as IpcWireError).reason).toBe('bad_id');
    });

    it('empty id => bad_id', () => {
      const raw = JSON.stringify({
        v: 1,
        type: 'req',
        channel: 'task',
        id: '',
        payload: {},
      });
      const err = (() => {
        try {
          parseWireFrame(raw);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(IpcWireError);
      expect((err as IpcWireError).reason).toBe('bad_id');
    });

    it('payload as array => bad_payload', () => {
      const raw = JSON.stringify({
        v: 1,
        type: 'req',
        channel: 'task',
        id: 'x',
        payload: [],
      });
      const err = (() => {
        try {
          parseWireFrame(raw);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(IpcWireError);
      expect((err as IpcWireError).reason).toBe('bad_payload');
    });

    it('missing payload => bad_payload', () => {
      const raw = JSON.stringify({
        v: 1,
        type: 'req',
        channel: 'task',
        id: 'x',
      });
      const err = (() => {
        try {
          parseWireFrame(raw);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(IpcWireError);
      expect((err as IpcWireError).reason).toBe('bad_payload');
    });

    it('ctrl frame with channel:null and ctrl:ping parses OK', () => {
      const raw = JSON.stringify({
        v: 1,
        type: 'ctrl',
        channel: null,
        ctrl: 'ping',
        id: 'x',
        payload: {},
      });
      const frame = parseWireFrame(raw);
      expect(frame.type).toBe('ctrl');
      expect(frame.channel).toBeNull();
      expect(frame.ctrl).toBe('ping');
    });

    it('ctrl frame with ctrl:bogus => bad_ctrl', () => {
      const raw = JSON.stringify({
        v: 1,
        type: 'ctrl',
        channel: null,
        ctrl: 'bogus',
        id: 'x',
        payload: {},
      });
      const err = (() => {
        try {
          parseWireFrame(raw);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(IpcWireError);
      expect((err as IpcWireError).reason).toBe('bad_ctrl');
    });
  });

  describe('isIpcWireChannel', () => {
    const channels = [
      'task',
      'memory',
      'browser',
      'permission',
      'user_question',
      'message',
      'continuation',
      'close',
      'live_tool_rules',
      'interaction_boundary',
    ];
    it.each(channels)('"%s" is a valid channel', (ch) => {
      expect(isIpcWireChannel(ch)).toBe(true);
    });
    it('non-member fails', () => {
      expect(isIpcWireChannel('bogus')).toBe(false);
      expect(isIpcWireChannel(null)).toBe(false);
      expect(isIpcWireChannel(1)).toBe(false);
    });
  });
});
