import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHmac, generateKeyPairSync } from 'crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-runner-mcp-ipc-'));
  tempRoots.push(root);
  return root;
}

function signPayloadWithAuthToken(
  authToken: string,
  payload: Record<string, unknown>,
): string {
  return createHmac('sha256', authToken)
    .update(Buffer.from(JSON.stringify(payload)))
    .digest('hex');
}

async function loadIpcModule(tempRoot: string, responseVerifyKey: string) {
  vi.resetModules();
  vi.stubEnv('GANTRY_IPC_DIR', tempRoot);
  vi.stubEnv('GANTRY_IPC_AUTH_TOKEN', 'mcp-test-auth-token');
  vi.stubEnv('GANTRY_BROWSER_IPC_AUTH_TOKEN', 'browser-test-auth-token');
  vi.stubEnv('GANTRY_MEMORY_IPC_AUTH_TOKEN', 'memory-test-auth-token');
  vi.stubEnv('GANTRY_IPC_RESPONSE_VERIFY_KEY', responseVerifyKey);
  vi.stubEnv('GANTRY_IPC_RESPONSE_KEY_ID', 'mcp-test-response-key-id');
  vi.stubEnv('GANTRY_CHAT_JID', 'tg:team');
  vi.stubEnv('GANTRY_GROUP_FOLDER', 'team');
  vi.stubEnv('GANTRY_ADMIN_MCP_TOOLS_JSON', '[]');
  return import('@core/runner/mcp/ipc.js');
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runner MCP IPC ids', () => {
  it('generates UUID-backed request ids and JSON filenames', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T00:00:00.000Z'));
    const { makeIpcId, makeIpcJsonFilename } =
      await import('@core/runner/mcp/ipc-ids.js');
    const uuidPattern =
      '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

    expect(makeIpcId('service-restart')).toMatch(
      new RegExp(`^service-restart-1778025600000-${uuidPattern}$`),
    );
    expect(makeIpcJsonFilename()).toMatch(
      new RegExp(`^1778025600000-${uuidPattern}\\.json$`),
    );
  });
});

describe('runner MCP IPC socket envelope signing', () => {
  it('signs bound warm-worker task envelopes with bind-delivered run handle and tokens', async () => {
    const tempRoot = makeTempRoot();
    const { publicKey } = generateKeyPairSync('ed25519');
    const responseVerifyKey = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    const { buildSignedTaskEnvelope } = await loadIpcModule(
      tempRoot,
      responseVerifyKey,
    );
    fs.writeFileSync(
      path.join(tempRoot, 'bound-identity.json'),
      JSON.stringify({
        chatJid: 'tg:bound',
        threadId: 'thread-bound',
        memoryUserId: 'user-bound',
        runHandle: 'bound-run-handle',
        ipcAuthToken: 'bound-ipc-auth-token',
        browserIpcAuthToken: 'bound-browser-auth-token',
        memoryIpcAuthToken: 'bound-memory-auth-token',
        ipcResponseKeyId: 'bound-response-key-id',
        ipcResponseVerifyKey: responseVerifyKey,
      }),
    );

    const envelope = buildSignedTaskEnvelope({
      type: 'task',
      payload: {},
    });
    const payload = { ...envelope };
    delete payload.signature;

    expect(envelope).toMatchObject({
      runHandle: 'bound-run-handle',
      context: {
        threadId: 'thread-bound',
        responseKeyId: 'bound-response-key-id',
      },
    });
    expect(envelope.signature).toBe(
      signPayloadWithAuthToken('bound-ipc-auth-token', payload),
    );
  });
});
