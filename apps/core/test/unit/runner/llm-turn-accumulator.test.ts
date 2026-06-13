import { describe, expect, it } from 'vitest';
import { LlmTurnAccumulator } from '@core/adapters/llm/anthropic-claude-agent/runner/llm-turn-accumulator.js';

/** Minimal BetaUsage-shaped object. */
function usage(over: Partial<Record<string, number>> = {}) {
  return {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 0,
    ...over,
  };
}

describe('LlmTurnAccumulator', () => {
  it('records one turn per assistant message with usage, model, stop_reason', () => {
    const acc = new LlmTurnAccumulator({ now: () => 1000 });
    acc.onAssistant(
      {
        message: {
          model: 'claude-sonnet-4-6',
          stop_reason: 'tool_use',
          usage: usage(),
        },
      },
      2000,
    );
    // turn closes at the next boundary
    acc.closeOpenTurn(2300);
    const turns = acc.turns();
    expect(turns.length).toBe(1);
    expect(turns[0].startedAt).toBe(2000);
    expect(turns[0].ms).toBe(300);
    expect(turns[0].detail).toEqual({
      model: 'claude-sonnet-4-6',
      stopReason: 'tool_use',
      tokens: { in: 100, out: 20, cacheRead: 80, cacheWrite: 0 },
    });
  });

  it('closes the previous turn when a new assistant message starts', () => {
    const acc = new LlmTurnAccumulator();
    acc.onAssistant(
      { message: { stop_reason: 'tool_use', usage: usage() } },
      10,
    );
    acc.onAssistant(
      {
        message: {
          stop_reason: 'end_turn',
          usage: usage({ output_tokens: 5 }),
        },
      },
      40,
    );
    acc.closeOpenTurn(60);
    const turns = acc.turns();
    expect(turns.length).toBe(2);
    expect(turns[0].ms).toBe(30); // 40 - 10
    expect(turns[1].ms).toBe(20); // 60 - 40
    expect(turns[1].detail.stopReason).toBe('end_turn');
  });

  it('maps BetaUsage cache fields, defaulting missing cache counts to 0', () => {
    const acc = new LlmTurnAccumulator();
    acc.onAssistant(
      {
        message: {
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      },
      5,
    );
    acc.closeOpenTurn(9);
    expect(acc.turns()[0].detail.tokens).toEqual({
      in: 7,
      out: 3,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('captures input/output payloads only when payload capture is enabled', () => {
    const on = new LlmTurnAccumulator({ capturePayloads: true });
    on.onAssistant({ message: { usage: usage() } }, 0, {
      input: 'IN',
      output: 'OUT',
    });
    on.closeOpenTurn(5);
    expect(on.turns()[0].input).toBe('IN');
    expect(on.turns()[0].output).toBe('OUT');

    const off = new LlmTurnAccumulator({ capturePayloads: false });
    off.onAssistant({ message: { usage: usage() } }, 0, {
      input: 'IN',
      output: 'OUT',
    });
    off.closeOpenTurn(5);
    expect(off.turns()[0].input).toBeUndefined();
    expect(off.turns()[0].output).toBeUndefined();
  });

  it('records no turns when no assistant message was seen', () => {
    const acc = new LlmTurnAccumulator();
    acc.closeOpenTurn(100);
    expect(acc.turns()).toEqual([]);
  });

  it('merges assistant events that share a message id into one turn (text + tool_use)', () => {
    // One Anthropic message is emitted by the SDK as two assistant events — a
    // text block and a tool_use block — sharing the same message.id. They must
    // collapse into ONE turn, not two (the empty tool_use one is a phantom).
    const acc = new LlmTurnAccumulator({ capturePayloads: true });
    acc.onAssistant({ message: { id: 'msg_1', usage: usage() } }, 100, {
      output: 'hello',
      input: 'PROMPT',
    });
    acc.onAssistant({ message: { id: 'msg_1', usage: usage() } }, 150, {
      output: '',
    });
    acc.closeOpenTurn(200);
    const turns = acc.turns();
    expect(turns.length).toBe(1);
    expect(turns[0].output).toBe('hello');
    expect(turns[0].input).toBe('PROMPT');
    expect(turns[0].ms).toBe(100); // 200 - 100 (the message's first event)
  });

  it('finalizes the open turn tokens + stop_reason from the message_delta usage', () => {
    // The assistant event carries only a mid-stream usage snapshot (out=1); the
    // authoritative final output_tokens arrive in the message_delta.
    const acc = new LlmTurnAccumulator();
    acc.onAssistant(
      { message: { id: 'msg_1', usage: usage({ output_tokens: 1 }) } },
      0,
    );
    acc.onFinalUsage(
      usage({
        output_tokens: 134,
        input_tokens: 1,
        cache_read_input_tokens: 9824,
        cache_creation_input_tokens: 435,
      }),
      'end_turn',
    );
    acc.closeOpenTurn(10);
    const t = acc.turns()[0];
    expect(t.detail.tokens).toEqual({
      in: 1,
      out: 134,
      cacheRead: 9824,
      cacheWrite: 435,
    });
    expect(t.detail.stopReason).toBe('end_turn');
  });
});
