import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function loadCredentialsStep() {
  const note = vi.fn();
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    note,
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }));
  const { runCredentialsStep, verifyModelAccess } =
    await import('@core/cli/setup-credentials.js');
  return { runCredentialsStep, verifyModelAccess, note };
}

describe('setup credentials step', () => {
  it('selects Gantry Model Gateway without collecting raw keys', async () => {
    const { runCredentialsStep, note } = await loadCredentialsStep();
    const draft = {
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
    };

    const action = await runCredentialsStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.credentialMode).toBe('gantry');
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('gantry credentials model set <provider>'),
      'Model Access',
    );
  });

  it('defers model credential validation to model preflight', async () => {
    const { verifyModelAccess } = await loadCredentialsStep();

    await expect(verifyModelAccess()).resolves.toEqual({
      ok: true,
      message:
        'Gantry Model Gateway credentials are stored in Postgres and validated during model preflight.',
    });
  });
});
