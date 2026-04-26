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
    vi.resetModules();
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
    vi.resetModules();
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

  it('does not treat leftover ONECLI_URL as auth in none mode', async () => {
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'none');
    vi.stubEnv('ONECLI_URL', 'http://localhost:10254');

    const { hasClaudeAuthConfigured, runClaudeQuery } =
      await import('@core/memory/claude-query.js');

    expect(hasClaudeAuthConfigured()).toBe(false);
    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).rejects.toThrow('Claude auth is not configured');
    expect(getContainerConfigMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('does not treat model-only external mode as configured auth', async () => {
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'external');
    vi.stubEnv('ONECLI_URL', '');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');

    const { hasClaudeAuthConfigured, runClaudeQuery } =
      await import('@core/memory/claude-query.js');

    expect(hasClaudeAuthConfigured()).toBe(false);
    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).rejects.toThrow('Claude auth is not configured');
    expect(getContainerConfigMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows external mode when a broker endpoint is configured', async () => {
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'external');
    vi.stubEnv('ONECLI_URL', '');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://broker.local/anthropic');
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

    const { hasClaudeAuthConfigured, runClaudeQuery } =
      await import('@core/memory/claude-query.js');

    expect(hasClaudeAuthConfigured()).toBe(true);
    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).resolves.toBe('[{"kind":"fact"}]');
    const call = queryMock.mock.calls[0]?.[0] as
      | {
          options?: {
            env?: Record<string, string>;
          };
        }
      | undefined;
    expect(call?.options?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
    });
    expect(getContainerConfigMock).not.toHaveBeenCalled();
  });

  it('uses runtime .env before ambient env for memory credential mode', async () => {
    fs.writeFileSync(
      path.join(runtimeRoot, '.env'),
      [
        'MYCLAW_CREDENTIAL_MODE=external',
        'ANTHROPIC_BASE_URL=https://broker.local/anthropic',
        'ANTHROPIC_MODEL=claude-haiku-4-5-20251001',
        '',
      ].join('\n'),
      'utf-8',
    );
    vi.resetModules();
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'none');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
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

    const { hasClaudeAuthConfigured, runClaudeQuery } =
      await import('@core/memory/claude-query.js');

    expect(hasClaudeAuthConfigured()).toBe(true);
    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).resolves.toBe('[{"kind":"fact"}]');
    const call = queryMock.mock.calls[0]?.[0] as
      | {
          options?: {
            env?: Record<string, string>;
          };
        }
      | undefined;
    expect(call?.options?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
    });
    expect(getContainerConfigMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe external broker endpoints before memory SDK queries', async () => {
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'external');
    vi.stubEnv('ONECLI_URL', '');
    vi.stubEnv(
      'ANTHROPIC_BASE_URL',
      'https://user:pass@broker.local/anthropic',
    );

    const { runClaudeQuery } = await import('@core/memory/claude-query.js');

    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).rejects.toThrow(
      'ANTHROPIC_BASE_URL must not contain embedded credentials',
    );
    expect(queryMock).not.toHaveBeenCalled();
    expect(getContainerConfigMock).not.toHaveBeenCalled();
  });
});
