import { afterEach, describe, expect, it } from 'vitest';
import { diag } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';

import {
  observeGatewayCall,
  type GatewayCallObservation,
} from '@core/adapters/llm/observability/genai-spans.js';
import {
  createSseAccumulator,
  createSseFrameSplitter,
  isOpenAiUsageOnlyFrame,
} from '@core/adapters/llm/observability/sse-accumulator.js';
import {
  initTracing,
  shutdownTracing,
  startTurnSpan,
} from '@core/infrastructure/observability/tracing.js';

const OPENAI_URL = new URL('https://llm.example/v1/chat/completions');
const MESSAGES_URL = new URL('https://llm.example/v1/messages');

function init(captureContent = true): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  initTracing(
    {
      enabled: true,
      captureContent,
      sampleRate: 1,
    },
    exporter,
  );
  return exporter;
}

function observe(input: {
  request: Record<string, unknown>;
  upstreamUrl?: URL;
  runId?: string;
  apiKeyId?: string;
  providerId?: string;
}): GatewayCallObservation {
  const observation = observeGatewayCall({
    token: { runId: input.runId, apiKeyId: input.apiKeyId },
    providerId: input.providerId ?? 'fixture-provider',
    upstreamUrl: input.upstreamUrl ?? OPENAI_URL,
    requestBody: Buffer.from(JSON.stringify(input.request)),
  });
  expect(observation).toBeDefined();
  return observation!;
}

function chatSpan(exporter: InMemorySpanExporter): ReadableSpan {
  const span = exporter
    .getFinishedSpans()
    .find(
      (candidate) => candidate.attributes['gen_ai.operation.name'] === 'chat',
    );
  expect(span).toBeDefined();
  return span!;
}

function frame(data: unknown, newline = '\n'): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${payload}${newline}${newline}`;
}

afterEach(async () => {
  await shutdownTracing();
  diag.disable();
});

describe('observeGatewayCall', () => {
  it('parents a matching gateway span to the registered turn span', () => {
    const exporter = init();
    const turn = startTurnSpan({
      runId: 'run-parent',
      agentName: 'Parent Agent',
    });
    const observation = observe({
      runId: 'run-parent',
      request: { model: 'request-model', messages: [] },
    });

    observation.finish({ status: 200, responseJson: {} });
    turn.end('success');

    const spans = exporter.getFinishedSpans();
    const gateway = spans.find((span) => span.name === 'chat request-model')!;
    const parent = spans.find(
      (span) => span.name === 'invoke_agent Parent Agent',
    )!;
    expect(gateway.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(gateway.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(gateway.attributes['gantry.component']).toBeUndefined();
  });

  it.each([
    [{ apiKeyId: 'key-1', runId: 'unregistered-key-run' }, 'llm-api'],
    [{ runId: 'memory-query:abc' }, 'memory'],
    [{ runId: 'permission-classifier:abc' }, 'permission-classifier'],
    [{ runId: 'unregistered-run' }, 'unattributed'],
  ] as const)(
    'makes unmatched calls root spans with component %s',
    (token, component) => {
      const exporter = init();
      const observation = observe({
        ...token,
        request: { model: 'request-model', messages: [] },
      });

      observation.finish({ status: 200, responseJson: {} });

      const span = chatSpan(exporter);
      expect(span.parentSpanContext).toBeUndefined();
      expect(span.attributes['gantry.component']).toBe(component);
    },
  );

  it('maps Anthropic response attributes and content', () => {
    const exporter = init();
    const observation = observe({
      upstreamUrl: MESSAGES_URL,
      request: {
        model: 'request-model',
        max_tokens: 512,
        system: 'System fixture',
        messages: [{ role: 'user', content: 'Prompt fixture' }],
      },
    });

    observation.finish({
      status: 200,
      responseJson: {
        id: 'response-id',
        model: 'response-model',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Completion fixture' }],
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        },
      },
    });

    const attributes = chatSpan(exporter).attributes;
    expect(attributes).toMatchObject({
      'gen_ai.request.model': 'request-model',
      'gen_ai.response.model': 'response-model',
      'gen_ai.response.id': 'response-id',
      'gen_ai.response.finish_reasons': ['end_turn'],
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.usage.cache_read_input_tokens': 5,
      'gen_ai.usage.cache_creation_input_tokens': 3,
    });
    expect(JSON.parse(String(attributes['gen_ai.prompt']))).toEqual([
      { role: 'system', content: 'System fixture' },
      { role: 'user', content: 'Prompt fixture' },
    ]);
    expect(JSON.parse(String(attributes['gen_ai.completion']))).toEqual([
      { role: 'assistant', content: 'Completion fixture' },
    ]);
  });

  it('maps OpenAI response attributes including cached tokens', () => {
    const exporter = init();
    const observation = observe({
      request: {
        model: 'request-model',
        temperature: 0.2,
        messages: [{ role: 'user', content: 'Prompt fixture' }],
      },
    });

    observation.finish({
      status: 200,
      responseJson: {
        model: 'response-model',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Completion fixture' },
          },
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 4,
          total_tokens: 13,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      },
    });

    const attributes = chatSpan(exporter).attributes;
    expect(attributes).toMatchObject({
      'gen_ai.request.model': 'request-model',
      'gen_ai.response.model': 'response-model',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 9,
      'gen_ai.usage.output_tokens': 4,
      'gen_ai.usage.total_tokens': 13,
      'gen_ai.usage.cached_tokens': 6,
    });
    expect(JSON.parse(String(attributes['gen_ai.prompt']))).toEqual([
      { role: 'user', content: 'Prompt fixture' },
    ]);
    expect(JSON.parse(String(attributes['gen_ai.completion']))).toEqual([
      { role: 'assistant', content: 'Completion fixture' },
    ]);
  });

  it('keeps token attributes but omits content when capture is disabled', () => {
    const exporter = init(false);
    const observation = observe({
      request: {
        model: 'request-model',
        messages: [{ role: 'user', content: 'private prompt' }],
      },
    });

    observation.finish({
      status: 200,
      responseJson: {
        choices: [{ message: { content: 'private completion' } }],
        usage: { prompt_tokens: 8, completion_tokens: 3 },
      },
    });

    const attributes = chatSpan(exporter).attributes;
    expect(attributes['gen_ai.prompt']).toBeUndefined();
    expect(attributes['gen_ai.completion']).toBeUndefined();
    expect(attributes['gen_ai.usage.input_tokens']).toBe(8);
    expect(attributes['gen_ai.usage.output_tokens']).toBe(3);
  });

  it('augments raw usage with canonical normalized cache attributes', () => {
    const exporter = init();
    const observation = observe({
      upstreamUrl: MESSAGES_URL,
      request: { model: 'request-model', messages: [] },
    });

    observation.finish({
      status: 200,
      responseJson: {
        usage: { input_tokens: 100, output_tokens: 20 },
      },
      normalizedUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        totalBillableInputTokens: 60,
        estimatedCostUsd: 0.001,
        cacheProvider: 'anthropic',
        cacheStatus: 'partial',
        at: '2026-07-14T00:00:00.000Z',
      },
    });

    expect(chatSpan(exporter).attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cache_read_input_tokens': 40,
      'gen_ai.usage.cache_creation_input_tokens': 10,
      'gen_ai.usage.cost': 0.001,
    });
  });

  it('bounds captured prompt and completion messages over 16k characters', () => {
    const exporter = init();
    const oversized = 'x'.repeat(17_000);
    const observation = observe({
      request: {
        model: 'request-model',
        messages: [{ role: 'user', content: oversized }],
      },
    });

    observation.finish({
      status: 200,
      responseJson: {
        choices: [{ message: { content: oversized } }],
      },
    });

    const attributes = chatSpan(exporter).attributes;
    const prompt = JSON.parse(String(attributes['gen_ai.prompt'])) as {
      content: string;
    }[];
    const completion = JSON.parse(String(attributes['gen_ai.completion'])) as {
      content: string;
    }[];
    expect(prompt[0]?.content).toHaveLength(16_012);
    expect(completion[0]?.content).toHaveLength(16_012);
    expect(prompt[0]?.content).toMatch(/…\[truncated\]$/);
    expect(completion[0]?.content).toMatch(/…\[truncated\]$/);
  });

  it('keeps oversized multi-message prompts valid within the attribute cap', () => {
    const exporter = init();
    const oversized = 'x'.repeat(17_000);
    const observation = observe({
      request: {
        model: 'request-model',
        messages: [
          { role: 'user', content: oversized },
          { role: 'assistant', content: oversized },
          { role: 'user', content: oversized },
        ],
      },
    });

    observation.finish({ status: 200, responseJson: {} });

    const prompt = String(chatSpan(exporter).attributes['gen_ai.prompt']);
    expect(prompt.length).toBeLessThanOrEqual(32_768);
    expect(JSON.parse(prompt)).toMatchObject([
      { role: 'user', content: expect.stringMatching(/…\[truncated\]$/) },
      { role: 'assistant', content: expect.stringMatching(/…\[truncated\]$/) },
      { role: 'user', content: expect.stringMatching(/…\[truncated\]$/) },
    ]);
  });

  it('releases all bytes and degrades to pass-through on a giant unterminated frame', () => {
    init();
    const observation = observe({
      providerId: 'openai',
      request: {
        model: 'request-model',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const tap = observation.streamTapFor('text/event-stream')!;
    const giant = Buffer.from(`data: {"x":"${'a'.repeat(1_100_000)}`, 'utf8');
    const after = Buffer.from('tail-bytes', 'utf8');

    const released = tap.transform(giant);
    expect(released.toString('utf8')).toBe(giant.toString('utf8'));
    expect(tap.transform(after)).toBe(after);
    expect(tap.flush()).toEqual(Buffer.alloc(0));
  });

  it('injects include_usage and strips only the synthetic usage frame', () => {
    const exporter = init();
    const observation = observe({
      providerId: 'openai',
      request: {
        model: 'request-model',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const forwarded = JSON.parse(observation.requestBody.toString('utf8')) as {
      stream_options?: { include_usage?: boolean };
    };
    expect(forwarded.stream_options?.include_usage).toBe(true);

    const contentChunk = Buffer.from(
      frame({
        model: 'response-model',
        choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
      }),
    );
    const usageChunk = Buffer.from(
      frame({
        model: 'response-model',
        choices: [],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      }),
    );
    expect(
      observation
        .streamTapFor('text/event-stream')
        ?.transform(contentChunk)
        .toString(),
    ).toBe(contentChunk.toString());
    expect(
      observation.streamTapFor('text/event-stream')?.transform(usageChunk),
    ).toEqual(Buffer.alloc(0));
    observation
      .streamTapFor('text/event-stream')
      ?.transform(Buffer.from(frame('[DONE]')));
    observation.finish({ status: 200 });

    const attributes = chatSpan(exporter).attributes;
    expect(attributes).toMatchObject({
      'gen_ai.response.model': 'response-model',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 5,
      'gen_ai.usage.output_tokens': 1,
      'gen_ai.usage.cached_tokens': 2,
    });
    expect(JSON.parse(String(attributes['gen_ai.completion']))).toEqual([
      { role: 'assistant', content: 'Hi' },
    ]);
  });

  it('accumulates and strips a delimiter-less terminal usage-only frame', () => {
    const exporter = init();
    const observation = observe({
      request: {
        model: 'request-model',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    observation.streamTapFor('text/event-stream')?.transform(
      Buffer.from(
        'data: ' +
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 3 },
            },
          }),
      ),
    );

    expect(observation.streamTapFor('text/event-stream')?.flush()).toEqual(
      Buffer.alloc(0),
    );
    observation.finish({ status: 200 });

    expect(chatSpan(exporter).attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 7,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.cached_tokens': 3,
    });
  });

  it.each([true, false])(
    'preserves caller include_usage=%s bodies and frames byte-for-byte',
    (includeUsage) => {
      init();
      const body = Buffer.from(
        JSON.stringify({
          model: 'request-model',
          stream: true,
          stream_options: { include_usage: includeUsage },
        }),
      );
      const observation = observeGatewayCall({
        token: {},
        providerId: 'fixture-provider',
        upstreamUrl: OPENAI_URL,
        requestBody: body,
      });
      expect(observation).toBeDefined();
      expect(observation?.requestBody).toBe(body);

      const usageFrame = Buffer.from(
        frame({ choices: [], usage: { prompt_tokens: 2 } }),
      );
      expect(
        observation?.streamTapFor('text/event-stream')?.transform(usageFrame),
      ).toBe(usageFrame);
      observation?.finish({ status: 200 });
    },
  );

  it('drains delimiter-less terminal usage after byte pass-through', () => {
    const exporter = init();
    const observation = observe({
      request: {
        model: 'request-model',
        stream: true,
        stream_options: { include_usage: true },
      },
    });
    const usageFrame = Buffer.from(
      'data: ' +
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 6, completion_tokens: 2 },
        }),
    );

    expect(
      observation.streamTapFor('text/event-stream')?.transform(usageFrame),
    ).toBe(usageFrame);
    expect(observation.streamTapFor('text/event-stream')?.flush()).toEqual(
      Buffer.alloc(0),
    );
    observation.finish({ status: 200 });

    expect(chatSpan(exporter).attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 6,
      'gen_ai.usage.output_tokens': 2,
    });
  });

  it('omits token attributes when an OpenAI stream has no usage chunk', () => {
    const exporter = init();
    const observation = observe({
      request: {
        model: 'request-model',
        stream: true,
        stream_options: { include_usage: true },
      },
    });
    observation.streamTapFor('text/event-stream')?.transform(
      Buffer.from(
        frame({
          choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
        }) + frame('[DONE]'),
      ),
    );
    observation.finish({ status: 200 });

    const attributes = chatSpan(exporter).attributes;
    expect(attributes['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(attributes['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(attributes['gen_ai.usage.total_tokens']).toBeUndefined();
  });

  it('does nothing when tracing is disabled', () => {
    expect(
      observeGatewayCall({
        token: {},
        providerId: 'fixture-provider',
        upstreamUrl: OPENAI_URL,
        requestBody: Buffer.from('{}'),
      }),
    ).toBeUndefined();
  });
});

describe('SSE accumulation', () => {
  it('accumulates Anthropic CRLF frames through DONE', () => {
    const accumulator = createSseAccumulator('anthropic', true);
    accumulator.push(
      Buffer.from(
        [
          frame(
            {
              type: 'message_start',
              message: {
                model: 'response-model',
                usage: { input_tokens: 11, cache_read_input_tokens: 4 },
              },
            },
            '\r\n',
          ),
          frame(
            {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'Hello ' },
            },
            '\r\n',
          ),
          frame(
            {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'world' },
            },
            '\r\n',
          ),
          frame(
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 2 },
            },
            '\r\n',
          ),
          frame('[DONE]', '\r\n'),
          frame(
            {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: ' ignored' },
            },
            '\r\n',
          ),
        ].join(''),
      ),
    );

    expect(accumulator.result()).toEqual({
      model: 'response-model',
      usage: {
        input_tokens: 11,
        cache_read_input_tokens: 4,
        output_tokens: 2,
      },
      completionText: 'Hello world',
      finishReason: 'end_turn',
    });
  });

  it('accumulates OpenAI streams with and without usage', () => {
    const withUsage = createSseAccumulator('openai', true);
    withUsage.push(
      Buffer.from(
        frame({
          model: 'response-model',
          choices: [{ delta: { content: 'Hi' }, finish_reason: null }],
        }) +
          frame({
            model: 'response-model',
            choices: [{ delta: {}, finish_reason: 'stop' }],
          }) +
          frame({
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          }),
      ),
    );
    expect(withUsage.result()).toEqual({
      model: 'response-model',
      usage: { prompt_tokens: 5, completion_tokens: 1 },
      completionText: 'Hi',
      finishReason: 'stop',
    });

    const withoutUsage = createSseAccumulator('openai', true);
    withoutUsage.push(
      Buffer.from(
        frame({
          model: 'response-model',
          choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
        }) + frame('[DONE]'),
      ),
    );
    expect(withoutUsage.result()).toEqual({
      model: 'response-model',
      completionText: 'Hi',
      finishReason: 'stop',
    });
  });

  it('stops after malformed data without throwing or losing prior data', () => {
    const accumulator = createSseAccumulator('openai', true);
    expect(() => {
      accumulator.push(
        Buffer.from(
          frame({
            model: 'response-model',
            choices: [{ delta: { content: 'kept' } }],
          }) +
            frame('{not json') +
            frame({ choices: [{ delta: { content: ' ignored' } }] }),
        ),
      );
    }).not.toThrow();
    expect(accumulator.result()).toEqual({
      model: 'response-model',
      completionText: 'kept',
    });
  });

  it('splits CRLF frames and detects only usage-only OpenAI frames', () => {
    const splitter = createSseFrameSplitter();
    expect(splitter.push(Buffer.from('data: one\r\n\r\ndata: tw'))).toEqual([
      'data: one',
    ]);
    expect(splitter.push(Buffer.from('o\r\n\r\n'))).toEqual(['data: two']);
    expect(splitter.flush()).toEqual([]);

    expect(
      isOpenAiUsageOnlyFrame(
        'data: {"choices":[],"usage":{"prompt_tokens":1}}',
      ),
    ).toBe(true);
    expect(
      isOpenAiUsageOnlyFrame(
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1}}',
      ),
    ).toBe(false);
    expect(isOpenAiUsageOnlyFrame('data: [DONE]')).toBe(false);
  });
});
