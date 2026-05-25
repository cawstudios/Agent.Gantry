import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSdkFilesystemSandbox,
  readLocalCliCredentialDirectories,
} from '@core/adapters/llm/anthropic-claude-agent/runner/filesystem-sandbox.js';

describe('Claude SDK filesystem sandbox settings', () => {
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    delete process.env.GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON;
  });

  it('keeps Bash sandboxed and enables macOS trustd lookup for approved CLI TLS', () => {
    const protectedPath = '/tmp/protected';

    expect(
      buildSdkFilesystemSandbox([protectedPath], { platform: 'darwin' }),
    ).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowLocalBinding: true },
      enableWeakerNetworkIsolation: true,
      filesystem: {
        denyRead: expect.arrayContaining([
          expect.stringMatching(/\/tmp\/protected$/),
        ]),
        denyWrite: expect.arrayContaining([
          expect.stringMatching(/\/tmp\/protected$/),
        ]),
      },
    });
  });

  it('does not request the macOS-only trustd exception on non-Darwin platforms', () => {
    expect(
      buildSdkFilesystemSandbox(['/tmp/protected'], { platform: 'linux' }),
    ).not.toHaveProperty('enableWeakerNetworkIsolation');
  });

  it('resolves reviewed local CLI credential directories from the host projection', () => {
    process.env.HOME = '/Users/tester';
    process.env.XDG_CONFIG_HOME = '/Users/tester/.config';
    process.env.GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON = JSON.stringify([
      '${XDG_CONFIG_HOME}/acme',
      '~/.config/acme',
      '${GANTRY_MISSING_CLI_CONFIG}/skip',
    ]);

    expect(readLocalCliCredentialDirectories()).toEqual([
      '/Users/tester/.config/acme',
    ]);
  });
});
