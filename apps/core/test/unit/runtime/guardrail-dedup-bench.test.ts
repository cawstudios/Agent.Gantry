// End-to-end regression guard for the double-guardrail bug. A single cold
// (no-agent) inbound message must be screened by the pre-agent guardrail EXACTLY
// ONCE across the full handoff: polling tick → GroupQueue.enqueueMessageCheck →
// processMessagesFn (the spawn path). Each screen costs one loadGuardrailContext
// read (getRecentMessages) + up to one classifier LLM call, so a second screen
// doubles both. Unlike the unit test in message-loop.test.ts (which stubs the
// queue and the context), this drives the REAL GroupQueue and the REAL
// loadGuardrailContext so the redundant context read is observable too.
//
// Scope: this proves the TICK defers (no second screen) and the queue handoff
// invokes the spawn screen exactly once. The processMessagesFn installed below
// MIRRORS processGroupMessages' pre-agent screen (load context → screen); that
// the *real* spawn path screens a cold message exactly once is covered in
// group-processing.test.ts ("agent guardrails" → "classifies ambiguous messages
// once"). Together they establish exactly-once end to end.
//
// Before the fix this measured { screens: 2, contextReads: 2 }; after, { 1, 1 }.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetNewMessages = vi.fn();
const mockGetMessagesSince = vi.fn();
const mockGetRecentMessages = vi.fn();
const mockEvaluateAgentGuardrail = vi.fn();
const mockCustomerVisibleGuardrailResponse = vi.fn();

vi.mock('@core/config/index.js', () => ({
  getTriggerPattern: () => /@Andy/i,
  MAX_MESSAGES_PER_PROMPT: 50,
  TIMEZONE: 'UTC',
}));
vi.mock('@core/platform/sender-allowlist.js', () => ({
  loadSenderAllowlist: () => ({}),
  loadSenderControlAllowlist: () => ({}),
  isSenderExplicitlyAllowed: () => false,
  isSenderControlAllowed: () => false,
  isTriggerAllowed: () => true,
}));
vi.mock('@core/session/session-commands.js', () => ({
  extractSessionCommand: () => null,
  isSessionCommandAllowed: () => false,
}));
vi.mock('@core/messaging/router.js', () => ({
  formatMessages: () => 'formatted messages',
}));
vi.mock('@core/application/guardrails/guardrail-service.js', () => ({
  evaluateAgentGuardrail: (...args: unknown[]) =>
    mockEvaluateAgentGuardrail(...args),
  customerVisibleGuardrailResponse: (...args: unknown[]) =>
    mockCustomerVisibleGuardrailResponse(...args),
}));

import type { MessageLoopDeps } from '@core/runtime/message-loop.js';
import type { ConversationRoute } from '@core/domain/types.js';

const guardedRoute = {
  name: 'Boondi',
  folder: 'boondi',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
  requiresTrigger: false,
  agentConfig: {
    plugins: { guardrail: { file: 'guardrail.ts', model: 'test-model' } },
  },
} as unknown as ConversationRoute;

const inboundMsg = {
  id: '1',
  chat_jid: 'group@g.us',
  sender: 'user@s.whatsapp.net',
  content: 'is this the right total for my order',
  timestamp: '2024-01-01T00:00:01.000Z',
  is_from_me: false,
  message_id: 'msg-1',
  reply_to_message_id: null,
  reply_to_content: null,
  sender_name: 'User',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNewMessages.mockReturnValue({
    messages: [inboundMsg],
    newTimestamp: '2024-01-01T00:00:01.000Z',
  });
  mockGetMessagesSince.mockReturnValue([inboundMsg]);
  mockGetRecentMessages.mockResolvedValue([]);
  mockEvaluateAgentGuardrail.mockResolvedValue({
    action: 'allow',
    reason: 'in_scope',
  });
  mockCustomerVisibleGuardrailResponse.mockReturnValue('canned');
});

describe('no-agent guardrail dedup (end-to-end)', () => {
  it('screens a cold message exactly once across the tick → queue → spawn handoff', async () => {
    const { GroupQueue } = await import('@core/runtime/group-queue.js');
    const { screenBatchPreAgent } =
      await import('@core/runtime/group-guardrail.js');
    const { runMessagePollingTick } =
      await import('@core/runtime/message-loop.js');

    const opsRepository = {
      getNewMessages: (...a: unknown[]) => mockGetNewMessages(...a),
      getMessagesSince: (...a: unknown[]) => mockGetMessagesSince(...a),
      getMessageThreadIds: () => [null],
      getRecentMessages: (...a: unknown[]) => mockGetRecentMessages(...a),
    } as unknown as MessageLoopDeps['opsRepository'];

    const queue = new GroupQueue();
    let resolveSpawn: () => void = () => undefined;
    const spawnDone = new Promise<void>((r) => {
      resolveSpawn = r;
    });
    // Mirror processGroupMessages' spawn-path screen via the shared helper.
    queue.setProcessMessagesFn(async (jid) => {
      try {
        await screenBatchPreAgent({
          repository: opsRepository!,
          group: guardedRoute,
          chatJid: 'group@g.us',
          queueJid: jid,
          threadId: null,
          messages: [inboundMsg],
          guardrailClassifier: vi.fn(),
          sendMessage: async () => undefined,
          buildMessageOptions: () => undefined,
          setCursor: () => undefined,
          saveState: () => undefined,
          info: () => undefined,
        });
      } finally {
        resolveSpawn();
      }
      return true;
    });

    const deps: MessageLoopDeps = {
      getConversationRoutes: () => ({ 'group@g.us': guardedRoute }),
      getLastTimestamp: () => '2024-01-01T00:00:00.000Z',
      setLastTimestamp: () => undefined,
      getOrRecoverCursor: () => '2024-01-01T00:00:00.000Z',
      setAgentCursor: () => undefined,
      saveState: () => undefined,
      hasChannel: () => true,
      setTyping: vi.fn().mockResolvedValue(undefined),
      sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      sendChannelMessage: vi.fn().mockResolvedValue(undefined),
      guardrailClassifier: vi.fn(),
      queue: queue as unknown as MessageLoopDeps['queue'],
      opsRepository,
    };

    await runMessagePollingTick(deps);
    await spawnDone;

    const screens = mockEvaluateAgentGuardrail.mock.calls.length;
    const contextReads = mockGetRecentMessages.mock.calls.length;
    // Exactly one screen + one context read on the no-agent path. The pre-fix
    // tick screened too, yielding { screens: 2, contextReads: 2 }.
    expect({ screens, contextReads }).toEqual({ screens: 1, contextReads: 1 });
  });
});
