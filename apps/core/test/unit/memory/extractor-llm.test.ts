import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArcExtractionInput } from '@core/memory/extractor-types.js';
import { LlmMemoryExtractionProvider } from '@core/memory/extractor-llm.js';

const claudeQueryMock = vi.hoisted(() => vi.fn());
const getContainerConfigMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: claudeQueryMock,
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: vi.fn(function OneCLI() {
    return {
      getContainerConfig: getContainerConfigMock,
    };
  }),
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '@core/infrastructure/logging/logger.js';

function configureClaudeQueryMock(): void {
  claudeQueryMock.mockImplementation(async function* () {
    const call = claudeQueryMock.mock.calls.at(-1)?.[0] as
      | {
          options?: {
            env?: Record<string, string>;
          };
        }
      | undefined;
    const env = call?.options?.env || {};
    const response = await globalThis.fetch(
      env.ANTHROPIC_BASE_URL || 'https://claude.local/mock',
      {
        method: 'POST',
        headers: env.ANTHROPIC_MODEL
          ? { 'x-myclaw-model': env.ANTHROPIC_MODEL }
          : undefined,
      },
    );
    const json = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = json.content?.find((entry) => entry.type === 'text')?.text;
    yield {
      type: 'assistant',
      message: {
        content: text ? [{ type: 'text', text }] : [],
      },
    };
  });
}

beforeEach(() => {
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('ONECLI_URL', 'http://localhost:10254');
  getContainerConfigMock.mockReset();
  getContainerConfigMock.mockResolvedValue({
    env: {
      ANTHROPIC_BASE_URL: 'https://broker.local/mock',
      ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  claudeQueryMock.mockReset();
  getContainerConfigMock.mockReset();
});

describe('LlmMemoryExtractionProvider', () => {
  it('uses broker-safe OneCLI env when extraction is enabled', async () => {
    configureClaudeQueryMock();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                {
                  scope: 'group',
                  kind: 'fact',
                  key: 'deploy-policy',
                  value: 'Use npm test before deploy.',
                  why: 'Team decision: use npm test before deploy.',
                  confidence: 0.91,
                },
              ]),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = new LlmMemoryExtractionProvider();
    const input: ArcExtractionInput = {
      turns: [
        { role: 'user', text: 'Team decision: use npm test before deploy.' },
        {
          role: 'assistant',
          text: 'We will use npm test before every deploy.',
        },
      ],
      trigger: 'session-end',
      retrievedItems: [],
    };

    const facts = await provider.extractFacts(input);
    expect(facts).toEqual([
      {
        scope: 'group',
        kind: 'fact',
        key: 'deploy-policy',
        value: 'Use npm test before deploy.',
        why: 'Team decision: use npm test before deploy.',
        confidence: 0.91,
      },
    ]);

    const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(requestInit?.headers as HeadersInit);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://broker.local/mock');
    expect(headers.get('x-myclaw-model')).toBe('claude-haiku-4-5-20251001');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-api-key')).toBeNull();
    expect(claudeQueryMock.mock.calls[0]?.[0]).toMatchObject({
      options: {
        env: {
          ANTHROPIC_BASE_URL: 'https://broker.local/mock',
          ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
        },
      },
    });
  });

  it('does not pre-filter non-keyword turns before LLM extraction', async () => {
    configureClaudeQueryMock();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '[]' }],
        }),
        { status: 200 },
      ),
    );

    const provider = new LlmMemoryExtractionProvider();
    const facts = await provider.extractFacts({
      turns: [
        { role: 'user', text: 'Check again please.' },
        { role: 'assistant', text: 'Done.' },
      ],
      trigger: 'precompact',
      retrievedItems: [],
    });

    expect(facts).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('runs LLM extraction for role assignment facts like CTO', async () => {
    configureClaudeQueryMock();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                {
                  scope: 'group',
                  kind: 'fact',
                  key: 'fact:cto',
                  value: 'CTO is Kartik Bansal.',
                  why: 'My CTO is Kartik Bansal.',
                  confidence: 0.9,
                },
              ]),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = new LlmMemoryExtractionProvider();
    const facts = await provider.extractFacts({
      turns: [
        { role: 'user', text: 'My CTO is Kartik Bansal.' },
        { role: 'assistant', text: 'Noted, I will remember that.' },
      ],
      trigger: 'session-end',
      retrievedItems: [],
    });

    expect(facts).toEqual([
      {
        scope: 'group',
        kind: 'fact',
        key: 'fact:cto',
        value: 'CTO is Kartik Bansal.',
        why: 'My CTO is Kartik Bansal.',
        confidence: 0.9,
      },
    ]);
  });

  it('redacts sensitive retrieved items before building outbound LLM prompt', async () => {
    configureClaudeQueryMock();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '[]' }],
        }),
        { status: 200 },
      ),
    );

    const provider = new LlmMemoryExtractionProvider();
    await provider.extractFacts({
      turns: [
        {
          role: 'user',
          text: 'Temporary key is sk-ant-abcdefghijklmnopqrstuvwxyz123456',
        },
        { role: 'assistant', text: 'Noted.' },
      ],
      trigger: 'precompact',
      retrievedItems: [
        {
          id: 'mem-1',
          key: 'auth:github_pat_abcd1234abcd1234abcd1234',
          value:
            'token=github_pat_abcd1234abcd1234abcd1234 and aws=AKIA1234567890ABCDEF',
        },
      ],
    });

    expect(claudeQueryMock).toHaveBeenCalled();
    const queryArg = claudeQueryMock.mock.calls[0]?.[0] as
      | { prompt?: string }
      | undefined;
    const prompt = queryArg?.prompt || '';
    expect(prompt).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz123456');
    expect(prompt).not.toContain('github_pat_abcd1234abcd1234abcd1234');
    expect(prompt).not.toContain('AKIA1234567890ABCDEF');
    expect(prompt).toContain('[REDACTED_SECRET]');
  });

  it('blocks outbound extraction when transcript contains uncertain secret-like material', async () => {
    configureClaudeQueryMock();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '[]' }],
        }),
        { status: 200 },
      ),
    );

    const provider = new LlmMemoryExtractionProvider();
    const facts = await provider.extractFacts({
      turns: [
        {
          role: 'user',
          text: 'credential blob q8N7_w9QfLh2Zr3Xy6Tt5Uv4sPd1Km0Qe9Jw2Nb7Hx3Y',
        },
        { role: 'assistant', text: 'Noted.' },
      ],
      trigger: 'precompact',
      retrievedItems: [],
    });

    expect(facts).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.any(String),
        trigger: 'precompact',
        reason: expect.any(String),
      }),
      'LLM extraction blocked due to potential sensitive transcript material',
    );
  });

  it('retries once on transient extractor failures', async () => {
    configureClaudeQueryMock();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: JSON.stringify([
                  {
                    scope: 'group',
                    kind: 'fact',
                    key: 'fact:retry-ok',
                    value: 'Retry recovered extraction.',
                    why: 'Retry recovered extraction.',
                    confidence: 0.9,
                  },
                ]),
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const provider = new LlmMemoryExtractionProvider();
    const facts = await provider.extractFacts({
      turns: [
        { role: 'user', text: 'Retry recovered extraction.' },
        { role: 'assistant', text: 'Noted.' },
      ],
      trigger: 'precompact',
      retrievedItems: [],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(facts).toEqual([
      {
        scope: 'group',
        kind: 'fact',
        key: 'fact:retry-ok',
        value: 'Retry recovered extraction.',
        why: 'Retry recovered extraction.',
        confidence: 0.9,
      },
    ]);
  });

  it('logs LLM extraction failures and skips extraction when auth is configured', async () => {
    configureClaudeQueryMock();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('oauth request rejected'),
    );

    const provider = new LlmMemoryExtractionProvider();
    const facts = await provider.extractFacts({
      turns: [
        { role: 'user', text: 'Team decision: use npm test before deploy.' },
        { role: 'assistant', text: 'Decision recorded.' },
      ],
      trigger: 'precompact',
      retrievedItems: [],
    });

    expect(facts).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        model: expect.any(String),
      }),
      'LLM extraction failed; skipping this boundary extraction',
    );
  });

  it('skips extraction when Claude auth is unavailable', async () => {
    vi.stubEnv('ONECLI_URL', '');
    const provider = new LlmMemoryExtractionProvider();

    const facts = await provider.extractFacts({
      turns: [
        { role: 'user', text: 'Team decision: use npm test before deploy.' },
        { role: 'assistant', text: 'Decision recorded.' },
      ],
      trigger: 'session-end',
      retrievedItems: [],
    });

    expect(facts).toEqual([]);
    expect(claudeQueryMock).not.toHaveBeenCalled();
  });
});
