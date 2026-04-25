import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function loadCredentialsStep(
  responses: unknown[],
  onecliEnvOrError: Record<string, string> | Error = {},
) {
  const text = vi.fn(async () => responses.shift());
  const note = vi.fn();
  const spinner = {
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  };
  const getContainerConfig = vi.fn(async () => {
    if (onecliEnvOrError instanceof Error) {
      throw onecliEnvOrError;
    }
    return { env: onecliEnvOrError };
  });
  const OneCLI = vi.fn(function () {
    return { getContainerConfig };
  });
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    text,
    note,
    select: vi.fn(async () => responses.shift()),
    spinner: vi.fn(() => spinner),
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }));
  vi.doMock('@onecli-sh/sdk', () => ({ OneCLI }));
  const { runCredentialsStep, verifyFirstAgentModelAccess } =
    await import('@core/cli/setup-credentials.js');
  return {
    runCredentialsStep,
    verifyFirstAgentModelAccess,
    text,
    note,
    spinner,
    OneCLI,
    getContainerConfig,
  };
}

describe('setup credentials step', () => {
  it('derives local OneCLI URL without prompting the user', async () => {
    const {
      runCredentialsStep,
      text,
      note,
      spinner,
      OneCLI,
      getContainerConfig,
    } = await loadCredentialsStep([], {
      ANTHROPIC_BASE_URL: 'http://localhost:10255/anthropic',
    });

    const draft = {
      credentialMode: 'onecli',
      onecliUrl: '',
      postgresSetupKind: 'local',
    };
    const action = await runCredentialsStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.onecliUrl).toBe('http://localhost:10254');
    expect(text).not.toHaveBeenCalled();
    expect(OneCLI).toHaveBeenCalledWith({ url: 'http://localhost:10254' });
    expect(getContainerConfig).toHaveBeenCalled();
    expect(spinner.start).toHaveBeenCalledWith('Validating Model Access...');
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('Model Access URL: http://localhost:10254'),
      'Model Access URL',
    );
  });

  it('keeps the reachability check for already provisioned or external Postgres', async () => {
    const { runCredentialsStep, spinner, OneCLI, getContainerConfig } =
      await loadCredentialsStep([], {
        ANTHROPIC_BASE_URL: 'http://localhost:10255/anthropic',
      });

    const action = await runCredentialsStep({
      credentialMode: 'onecli',
      onecliUrl: '',
      postgresSetupKind: 'existing',
    });

    expect(action).toEqual({ type: 'next' });
    expect(OneCLI).toHaveBeenCalledWith({ url: 'http://localhost:10254' });
    expect(getContainerConfig).toHaveBeenCalled();
    expect(spinner.start).toHaveBeenCalledWith('Validating Model Access...');
  });

  it('verifies first-agent model access with broker-safe env', async () => {
    const { verifyFirstAgentModelAccess, getContainerConfig } =
      await loadCredentialsStep([], {
        ANTHROPIC_BASE_URL: 'http://localhost:10255/anthropic',
      });

    const result = await verifyFirstAgentModelAccess('http://localhost:10254');

    expect(result.ok).toBe(true);
    expect(result.message).toContain('broker-safe');
    expect(getContainerConfig).toHaveBeenCalled();
  });

  it('fails first-agent model access when OneCLI returns raw provider credentials', async () => {
    const { verifyFirstAgentModelAccess } = await loadCredentialsStep([], {
      OPENAI_API_KEY: 'sk-secret',
    });

    const result = await verifyFirstAgentModelAccess('http://localhost:10254');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('forbidden raw credential');
    expect(result.nextAction).toContain('Open Model Access');
  });

  it('fails first-agent model access for invalid Model Access URLs', async () => {
    const { verifyFirstAgentModelAccess, getContainerConfig } =
      await loadCredentialsStep([]);

    const result = await verifyFirstAgentModelAccess('http://onecli.example');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('ONECLI_URL must use HTTPS');
    expect(result.nextAction).toContain('Open Model Access');
    expect(getContainerConfig).not.toHaveBeenCalled();
  });

  it('fails first-agent model access with actionable guidance when OneCLI is unreachable', async () => {
    const { verifyFirstAgentModelAccess, getContainerConfig } =
      await loadCredentialsStep([], new Error('gateway unavailable'));

    const result = await verifyFirstAgentModelAccess('http://localhost:10254');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('gateway unavailable');
    expect(result.nextAction).toContain('Open Model Access');
    expect(getContainerConfig).toHaveBeenCalled();
  });
});
