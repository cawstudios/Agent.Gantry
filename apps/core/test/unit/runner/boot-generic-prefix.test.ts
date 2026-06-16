import { describe, expect, it } from 'vitest';

import { composeSystemPromptAppend } from '@core/runner/memory-boundary.js';
import { buildRunnerSystemPrompt } from '@core/adapters/llm/anthropic-claude-agent/runner/system-prompt.js';
import type { AgentRunnerInput } from '@core/adapters/llm/anthropic-claude-agent/runner/types.js';
import bssCustomerSupportPolicy from '../../../../../agents/boondi_support/guardrails/guardrail.ts';

function baseInput(
  overrides: Partial<AgentRunnerInput> = {},
): AgentRunnerInput {
  return {
    prompt: 'hello',
    groupFolder: 'boondi_support',
    chatJid: 'wa:919654405340',
    compiledSystemPrompt: 'PREFIX',
    ...overrides,
  };
}

describe('boot-generic prefix (Pillar 2 §2.3)', () => {
  // Fix #1: on a GENERIC/WARM boot the durable-memory boundary policy is forced
  // unconditional so the cached system-prompt prefix is byte-identical whether
  // or not a customer has a memory block (the cache anchor). Outside generic
  // boot (the cold path) it stays gated on memory presence — see below.
  it('generic boot forces the boundary policy (byte-identical prefix regardless of memory)', () => {
    const withMem = composeSystemPromptAppend('PREFIX', true, {
      forceBoundaryPolicy: true,
    });
    const noMem = composeSystemPromptAppend('PREFIX', false, {
      forceBoundaryPolicy: true,
    });
    expect(noMem).toBe(withMem); // policy always present under generic boot
    expect(noMem).toContain('Gantry Durable Memory Boundary');
  });

  // Cold path (forceBoundaryPolicy not set) with NO memory: the policy is
  // ABSENT — this restores today's pool-off behavior and keeps the cold prompt
  // byte-identical to pre-Pillar-2.
  it('cold path with no memory OMITS the boundary policy (pool-off equivalence)', () => {
    const noMem = composeSystemPromptAppend('PREFIX', false);
    expect(noMem).not.toContain('Gantry Durable Memory Boundary');
    expect(noMem).toBe('PREFIX');
  });

  // Cold path with memory present: the policy IS included (unchanged behavior).
  it('cold path with memory includes the boundary policy (unchanged)', () => {
    const withMem = composeSystemPromptAppend('PREFIX', true);
    expect(withMem).toContain('Gantry Durable Memory Boundary');
    expect(withMem).toContain('PREFIX');
  });

  // Fix #2: a generic boot must NOT bake the per-customer guardrail append into
  // the cached prefix (it rides the first user message per-turn instead). Two
  // generic boots with DIFFERENT guardrail appends must produce a byte-identical
  // boot systemPrompt.
  it('generic boot omits the guardrail append → byte-identical prefix across customers', () => {
    const guardrailA = bssCustomerSupportPolicy.systemPromptAppend?.([
      'Can you help me with this?',
    ]);
    const guardrailB = bssCustomerSupportPolicy.systemPromptAppend?.([
      'Where is my order #12345?',
    ]);

    const promptA = buildRunnerSystemPrompt(
      baseInput({ guardrailSystemPromptAppend: guardrailA } as never),
      '',
      {},
      { genericBoot: true },
    );
    const promptB = buildRunnerSystemPrompt(
      baseInput({ guardrailSystemPromptAppend: guardrailB } as never),
      'MEM-FOR-B',
      {},
      { genericBoot: true },
    );

    expect(promptA?.append).toBe(promptB?.append);
    // Guardrail text must NOT be in the cached prefix on a generic boot.
    expect(promptA?.append).not.toContain('Boondi Scope Check For This Turn');
    // The unconditional boundary policy IS part of the shared prefix.
    expect(promptA?.append).toContain('Gantry Durable Memory Boundary');
    expect(promptA?.append).toContain('PREFIX');
  });

  it('generic boot prompt bytes are identical for two distinct customers', () => {
    const customerA = buildRunnerSystemPrompt(
      baseInput({
        chatJid: 'wa:111',
        threadId: 'thread-a',
        memoryUserId: 'user-a',
        prompt: 'show sweets for Diwali',
        guardrailSystemPromptAppend: 'CUSTOMER-A-GUARDRAIL',
      } as never),
      '<memory>A</memory>',
      {},
      { genericBoot: true },
    );
    const customerB = buildRunnerSystemPrompt(
      baseInput({
        chatJid: 'wa:222',
        threadId: 'thread-b',
        memoryUserId: 'user-b',
        prompt: 'track order 123',
        guardrailSystemPromptAppend: 'CUSTOMER-B-GUARDRAIL',
      } as never),
      '<memory>B</memory>',
      {},
      { genericBoot: true },
    );

    expect(customerA?.append).toBe(customerB?.append);
    expect(customerA?.append).not.toContain('wa:111');
    expect(customerA?.append).not.toContain('CUSTOMER-A-GUARDRAIL');
    expect(customerB?.append).not.toContain('wa:222');
    expect(customerB?.append).not.toContain('CUSTOMER-B-GUARDRAIL');
  });

  // The cold path is unchanged: the guardrail append still rides the boot prompt.
  it('cold boot keeps the guardrail append in the system prompt (unchanged)', () => {
    const guardrail = bssCustomerSupportPolicy.systemPromptAppend?.([
      'Can you help me with this?',
    ]);
    const prompt = buildRunnerSystemPrompt(
      baseInput({ guardrailSystemPromptAppend: guardrail } as never),
      '',
      {},
    );
    expect(prompt?.append).toContain('Boondi Scope Check For This Turn');
    expect(prompt?.append).toContain('PREFIX');
  });
});
