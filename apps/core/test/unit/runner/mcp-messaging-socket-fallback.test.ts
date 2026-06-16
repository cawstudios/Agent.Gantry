import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IpcRequestError } from '@core/shared/ipc-socket-client.js';
import type { TaskSocketClientLike } from '@agent-runner-src/mcp/ipc.js';

type ToolHandler = (
  args: Record<string, unknown>,
  context?: { signal?: AbortSignal },
) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

class FakeMcpSocketClient implements TaskSocketClientLike {
  connected: boolean;
  connectCalls = 0;
  requestCalls: Array<{ channel: string; id?: string }> = [];
  sendCalls: Array<{ channel: string; payload: Record<string, unknown> }> = [];

  constructor(
    private readonly behavior: {
      connected?: boolean;
      connectFails?: boolean;
      requestFails?: boolean;
    } = {},
  ) {
    this.connected = behavior.connected ?? false;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.behavior.connectFails) {
      throw new IpcRequestError('connection lost: connect', 'connection_lost');
    }
    this.connected = this.behavior.connected ?? true;
  }

  async request(
    channel: 'task' | 'memory' | 'user_question' | 'browser',
    _signedPayload: Record<string, unknown>,
    opts?: { id?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    this.requestCalls.push({ channel, id: opts?.id });
    if (this.behavior.requestFails) {
      throw new IpcRequestError('connection lost: drop', 'connection_lost');
    }
    return { ok: true, requestId: opts?.id ?? 'request-id', signature: 'sig' };
  }

  send(channel: 'message', signedPayload: Record<string, unknown>): void {
    this.sendCalls.push({ channel, payload: signedPayload });
  }
}

let tempDir: string;
let oldEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  vi.resetModules();
  oldEnv = { ...process.env };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-msg-socket-'));
  process.env.GANTRY_IPC_DIR = tempDir;
  process.env.GANTRY_IPC_AUTH_TOKEN = 'mcp-test-token';
  process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY = 'verify-key';
  process.env.GANTRY_IPC_RESPONSE_KEY_ID = 'response-key';
  process.env.GANTRY_CHAT_JID = 'tg:team';
  process.env.GANTRY_GROUP_FOLDER = 'team';
  process.env.GANTRY_IPC_SOCKET_PATH = path.join(tempDir, 'core.sock');
});

afterEach(() => {
  process.env = oldEnv;
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function loadMessagingTools(): Promise<{
  handlers: Record<string, ToolHandler>;
  setClient: (client: TaskSocketClientLike | null | undefined) => void;
}> {
  const ipc = await import('@agent-runner-src/mcp/ipc.js');
  const messaging = await import('@agent-runner-src/mcp/tools/messaging.js');
  const handlers: Record<string, ToolHandler> = {};
  messaging.registerMessagingTools({
    tool: (
      name: string,
      _description: string,
      _schema: unknown,
      handler: ToolHandler,
    ) => {
      handlers[name] = handler;
    },
  } as never);
  return {
    handlers,
    setClient: ipc.__setTaskSocketClientForTest,
  };
}

function text(result: {
  content: Array<{ type: 'text'; text: string }>;
}): string {
  return result.content[0]?.text ?? '';
}

describe('MCP messaging tools socket-only boundary', () => {
  it('send_message fails when the socket is disconnected', async () => {
    const { handlers, setClient } = await loadMessagingTools();
    const fake = new FakeMcpSocketClient({ connectFails: true });
    setClient(fake);

    const result = await handlers.send_message?.({ text: 'hello' });

    expect(text(result!)).toMatch(/socket/i);
    expect(fake.sendCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(tempDir, 'messages'))).toBe(false);
  });

  it('ask_user_question does not write an unserviceable fs question when socket drops', async () => {
    const { handlers, setClient } = await loadMessagingTools();
    const fake = new FakeMcpSocketClient({
      connected: true,
      requestFails: true,
    });
    setClient(fake);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 2500);

    try {
      const result = await handlers.ask_user_question?.(
        {
          questions: [
            {
              question: 'Continue?',
              header: 'Choice',
              options: [
                { label: 'Yes', description: 'Proceed' },
                { label: 'No', description: 'Stop' },
              ],
              multiSelect: false,
            },
          ],
        },
        { signal: controller.signal },
      );

      expect(text(result!)).toMatch(/connection lost: drop/);
      expect(fake.requestCalls).toHaveLength(1);
      const questionDir = path.join(tempDir, 'user-questions');
      const questionFiles = fs.existsSync(questionDir)
        ? fs.readdirSync(questionDir).filter((file) => file.endsWith('.json'))
        : [];
      expect(questionFiles).toHaveLength(0);
    } finally {
      clearTimeout(abortTimer);
    }
  });
});
