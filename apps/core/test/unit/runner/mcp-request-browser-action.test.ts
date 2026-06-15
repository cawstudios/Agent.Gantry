import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { IpcRequestError } from '@core/shared/ipc-socket-client.js';
import type { TaskSocketClientLike } from '@agent-runner-src/mcp/ipc.js';

// context.ts (loaded transitively by ipc.ts) requires GANTRY_IPC_DIR at module
// load. Set the env, THEN dynamically import the module under test so the
// static (hoisted) import order can't evaluate context.ts before the env.
const IPC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-req-browser-'));
const BROWSER_REQUESTS_DIR = path.join(IPC_DIR, 'browser-requests');
const BROWSER_RESPONSES_DIR = path.join(IPC_DIR, 'browser-responses');

let requestBrowserAction: typeof import('@agent-runner-src/mcp/ipc.js').requestBrowserAction;
let classifyBrowserSocketError: typeof import('@agent-runner-src/mcp/ipc.js').classifyBrowserSocketError;
let __setTaskSocketClientForTest: typeof import('@agent-runner-src/mcp/ipc.js').__setTaskSocketClientForTest;

// An ed25519 key pair so the fs-fallback path's response-signature verification
// can be satisfied (GANTRY_IPC_RESPONSE_VERIFY_KEY must be the public key).
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const RESPONSE_VERIFY_KEY = publicKey
  .export({ format: 'pem', type: 'spki' })
  .toString();
const RESPONSE_SIGNING_KEY = privateKey
  .export({ format: 'pem', type: 'pkcs8' })
  .toString();

function signResponse(payload: Record<string, unknown>): string {
  return cryptoSign(
    null,
    Buffer.from(JSON.stringify(payload)),
    RESPONSE_SIGNING_KEY,
  )
    .toString('base64')
    .trim();
}

beforeAll(async () => {
  process.env.GANTRY_IPC_DIR = IPC_DIR;
  process.env.GANTRY_GROUP_FOLDER = process.env.GANTRY_GROUP_FOLDER ?? 'team';
  process.env.GANTRY_CHAT_JID = process.env.GANTRY_CHAT_JID ?? 'tg:team';
  process.env.GANTRY_BROWSER_IPC_AUTH_TOKEN =
    process.env.GANTRY_BROWSER_IPC_AUTH_TOKEN ?? 'browser-test-token';
  process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY = RESPONSE_VERIFY_KEY;
  process.env.GANTRY_IPC_RESPONSE_KEY_ID =
    process.env.GANTRY_IPC_RESPONSE_KEY_ID ?? 'browser-test-response-key-id';
  const mod = await import('@agent-runner-src/mcp/ipc.js');
  requestBrowserAction = mod.requestBrowserAction;
  classifyBrowserSocketError = mod.classifyBrowserSocketError;
  __setTaskSocketClientForTest = mod.__setTaskSocketClientForTest;
});

afterEach(() => {
  __setTaskSocketClientForTest(undefined);
  vi.restoreAllMocks();
  fs.rmSync(BROWSER_REQUESTS_DIR, { recursive: true, force: true });
  fs.rmSync(BROWSER_RESPONSES_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// classifyBrowserSocketError — the full branch matrix, deterministically.
// ---------------------------------------------------------------------------

describe('classifyBrowserSocketError', () => {
  it('maps a timeout to the fs path deadline result (no fs replay)', () => {
    const d = classifyBrowserSocketError(
      new IpcRequestError('request timed out', 'timeout'),
      30_000,
    );
    expect(d).toEqual({
      kind: 'result',
      result: {
        ok: false,
        error:
          'Browser IPC timeout after 30s waiting for browser service response',
      },
    });
  });

  it.each(['connection_lost', 'not_connected', 'busy'])(
    'maps transient code %s to a fs fallback',
    (code) => {
      const d = classifyBrowserSocketError(
        new IpcRequestError('x', code),
        1000,
      );
      expect(d).toEqual({ kind: 'fallback' });
    },
  );

  it('maps a non-protocol error to a fs fallback (never fails hard)', () => {
    const d = classifyBrowserSocketError(new Error('boom'), 1000);
    expect(d).toEqual({ kind: 'fallback' });
  });

  it.each([
    ['bad_signature', 'bad response signature'],
    ['invalid_request', 'invalid_request'],
    ['internal_error', 'internal_error'],
    ['rate_limited', 'rate_limited'],
  ])(
    'surfaces a {ok:false} result for non-transient code %s',
    (code, message) => {
      const d = classifyBrowserSocketError(
        new IpcRequestError(message, code),
        1000,
      );
      expect(d).toEqual({
        kind: 'result',
        result: { ok: false, error: message },
      });
    },
  );
});

// ---------------------------------------------------------------------------
// requestBrowserAction — socket path with an injected fake client.
// ---------------------------------------------------------------------------

class FakeBrowserSocketClient implements TaskSocketClientLike {
  connected = false;
  connectCalls = 0;
  requestCalls: Array<{
    channel: string;
    id?: string;
    timeoutMs?: number;
    payload: Record<string, unknown>;
  }> = [];

  constructor(
    private readonly behavior: {
      connectFails?: boolean;
      onRequest: (
        payload: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    },
  ) {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.behavior.connectFails) {
      throw new IpcRequestError('connection lost: x', 'connection_lost');
    }
    this.connected = true;
  }

  async request(
    channel: 'task' | 'memory' | 'user_question' | 'browser',
    signedPayload: Record<string, unknown>,
    opts?: { id?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    this.requestCalls.push({
      channel,
      id: opts?.id,
      timeoutMs: opts?.timeoutMs,
      payload: signedPayload,
    });
    return this.behavior.onRequest(signedPayload);
  }

  send(): void {
    throw new Error('send not used by browser');
  }
}

describe('requestBrowserAction (socket mode, injected fake client)', () => {
  it('connects, sends the signed browser envelope, maps the resp', async () => {
    const fake = new FakeBrowserSocketClient({
      onRequest: async () => ({
        ok: true,
        requestId: 'ignored',
        data: { content: 'navigated' },
        signature: 'sig',
      }),
    });
    __setTaskSocketClientForTest(fake);

    const resp = await requestBrowserAction(
      'navigate',
      { url: 'https://example.test' },
      { timeoutMs: 30_000, publicToolName: 'browser_act' },
    );

    expect(fake.connectCalls).toBe(1);
    expect(fake.requestCalls).toHaveLength(1);
    const call = fake.requestCalls[0];
    expect(call.channel).toBe('browser');
    expect(call.timeoutMs).toBe(30_000);
    // The socket request id correlates with the signed envelope's requestId.
    expect(call.id).toBe(String(call.payload.requestId));
    // The payload is the signed browser envelope (chat-scoped HMAC + freshness).
    expect(typeof call.payload.signature).toBe('string');
    expect(call.payload.action).toBe('navigate');
    expect((call.payload.context as Record<string, unknown>).chatJid).toBe(
      'tg:team',
    );
    expect(
      (call.payload.context as Record<string, unknown>).publicToolName,
    ).toBe('browser_act');

    expect(resp).toEqual({ ok: true, data: { content: 'navigated' } });
    // No fs request file is written on the socket happy path.
    expect(fs.existsSync(BROWSER_REQUESTS_DIR)).toBe(false);
  });

  it('maps a socket timeout to the fs deadline result without fs fallback', async () => {
    const fake = new FakeBrowserSocketClient({
      onRequest: async () => {
        throw new IpcRequestError('request timed out', 'timeout');
      },
    });
    __setTaskSocketClientForTest(fake);

    const resp = await requestBrowserAction(
      'status',
      {},
      { timeoutMs: 30_000 },
    );

    expect(resp).toEqual({
      ok: false,
      error:
        'Browser IPC timeout after 30s waiting for browser service response',
    });
    expect(fs.existsSync(BROWSER_REQUESTS_DIR)).toBe(false); // no fs on timeout
  });

  it('surfaces a {ok:false} for a non-transient server rejection (final)', async () => {
    const fake = new FakeBrowserSocketClient({
      onRequest: async () => {
        throw new IpcRequestError('forged frame', 'invalid_request');
      },
    });
    __setTaskSocketClientForTest(fake);

    const resp = await requestBrowserAction('status', {}, { timeoutMs: 5000 });

    expect(resp).toEqual({ ok: false, error: 'forged frame' });
    expect(fs.existsSync(BROWSER_REQUESTS_DIR)).toBe(false); // a real reject is final
  });

  it('falls back to the fs path on a transient socket failure (connection_lost)', async () => {
    const fake = new FakeBrowserSocketClient({
      onRequest: async () => {
        throw new IpcRequestError('connection lost: drop', 'connection_lost');
      },
    });
    __setTaskSocketClientForTest(fake);

    const pending = requestBrowserAction('status', {}, { timeoutMs: 3000 });

    // The fs fallback writes a request file; satisfy its poll with a signed resp.
    await vi.waitFor(() => {
      expect(fs.existsSync(BROWSER_REQUESTS_DIR)).toBe(true);
      expect(fs.readdirSync(BROWSER_REQUESTS_DIR).length).toBeGreaterThan(0);
    });
    const requestId = path.basename(
      fs.readdirSync(BROWSER_REQUESTS_DIR)[0],
      '.json',
    );
    const responsePayload = {
      ok: true,
      requestId,
      data: { running: true },
    };
    fs.mkdirSync(BROWSER_RESPONSES_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(BROWSER_RESPONSES_DIR, `${requestId}.json`),
      JSON.stringify({
        ...responsePayload,
        signature: signResponse(responsePayload),
      }),
    );

    const resp = await pending;
    expect(resp).toEqual({ ok: true, data: { running: true } });
    expect(fake.requestCalls).toHaveLength(1); // socket was attempted first
  });

  it('falls back to the fs path when the socket connect fails', async () => {
    const fake = new FakeBrowserSocketClient({
      connectFails: true,
      onRequest: async () => ({ ok: true }),
    });
    __setTaskSocketClientForTest(fake);

    const pending = requestBrowserAction('status', {}, { timeoutMs: 3000 });

    await vi.waitFor(() => {
      expect(fs.existsSync(BROWSER_REQUESTS_DIR)).toBe(true);
      expect(fs.readdirSync(BROWSER_REQUESTS_DIR).length).toBeGreaterThan(0);
    });
    const requestId = path.basename(
      fs.readdirSync(BROWSER_REQUESTS_DIR)[0],
      '.json',
    );
    const responsePayload = { ok: true, requestId, data: { running: true } };
    fs.mkdirSync(BROWSER_RESPONSES_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(BROWSER_RESPONSES_DIR, `${requestId}.json`),
      JSON.stringify({
        ...responsePayload,
        signature: signResponse(responsePayload),
      }),
    );

    const resp = await pending;
    expect(resp).toEqual({ ok: true, data: { running: true } });
    expect(fake.connectCalls).toBe(1);
    expect(fake.requestCalls).toHaveLength(0); // never reached request()
  });
});
