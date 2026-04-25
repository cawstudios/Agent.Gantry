import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
const getContainerConfigMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: vi.fn(function OneCLI() {
    return {
      getContainerConfig: getContainerConfigMock,
    };
  }),
}));

describe('runClaudeQuery', () => {
  let runtimeRoot = '';

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-claude-query-'),
    );
    fs.writeFileSync(
      path.join(runtimeRoot, 'settings.yaml'),
      [
        'storage:',
        '  postgres:',
        '    url_env: MYCLAW_DATABASE_URL',
        '    schema: myclaw',
        '',
      ].join('\n'),
      'utf-8',
    );
    vi.stubEnv('MYCLAW_HOME', runtimeRoot);
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ONECLI_URL', 'http://localhost:10254');
    queryMock.mockReset();
    getContainerConfigMock.mockReset();
    getContainerConfigMock.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
        CUSTOM_FLAG: 'ignored',
      },
    });
  });

  afterEach(() => {
    if (runtimeRoot) {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      runtimeRoot = '';
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('passes only broker-safe OneCLI env into SDK query env', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '[{"kind":"fact"}]' }],
          },
        };
      })(),
    );

    const { runClaudeQuery } = await import('@core/memory/claude-query.js');
    await runClaudeQuery({
      model: 'claude-haiku-4-5-20251001',
      prompt: 'Extract facts',
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(getContainerConfigMock).toHaveBeenCalledWith('memory');
    const call = queryMock.mock.calls[0]?.[0] as
      | {
          prompt?: string;
          options?: {
            env?: Record<string, string>;
          };
        }
      | undefined;
    expect(call?.prompt).toBe('Extract facts');
    expect(call?.options?.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
    });
  });

  it('fails closed when OneCLI returns raw provider credentials', async () => {
    getContainerConfigMock.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
        ANTHROPIC_API_KEY: 'must-not-reach-sdk-env',
      },
    });

    const { runClaudeQuery } = await import('@core/memory/claude-query.js');

    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).rejects.toThrow(/forbidden raw credential env key: ANTHROPIC_API_KEY/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('drops container-local certificate paths returned by OneCLI', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '[{"kind":"fact"}]' }],
          },
        };
      })(),
    );
    getContainerConfigMock.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
        NODE_EXTRA_CA_CERTS: '/tmp/onecli-ca.pem',
      },
    });

    const { runClaudeQuery } = await import('@core/memory/claude-query.js');

    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).resolves.toBe('[{"kind":"fact"}]');
    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as
      | {
          options?: {
            env?: Record<string, string>;
          };
        }
      | undefined;
    expect(call?.options?.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
    });
  });
});
