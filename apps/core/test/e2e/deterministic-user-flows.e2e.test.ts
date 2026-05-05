import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRuntimeSettings } from '@core/config/settings/runtime-settings.js';

import { createRuntimeHomeFixture } from '../harness/runtime-home-fixture.js';

const fixtures: Array<{ cleanup(): void }> = [];

interface CliHarness {
  runtimeHome: string;
  stdout: string[];
  stderr: string[];
  notes: Array<{ message: string; title?: string }>;
  logs: {
    error: string[];
    info: string[];
    success: string[];
    warn: string[];
  };
  serviceCalls: Array<{ action: string; runtimeHome: string }>;
  run(args: string[]): Promise<number>;
  readSettings(): ReturnType<typeof loadRuntimeSettings>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  fixtures.splice(0).forEach((fixture) => fixture.cleanup());
});

async function createCliHarness(options?: {
  serviceStatus?: string;
  preflightOk?: boolean;
  mutateSettings?: Parameters<
    typeof createRuntimeHomeFixture
  >[0]['mutateSettings'];
  env?: Record<string, string>;
}): Promise<CliHarness> {
  const fixture = createRuntimeHomeFixture({
    prefix: 'myclaw-deterministic-e2e-',
    mutateSettings: options?.mutateSettings,
    env: options?.env,
  });
  fixtures.push(fixture);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const notes: CliHarness['notes'] = [];
  const logs: CliHarness['logs'] = {
    error: [],
    info: [],
    success: [],
    warn: [],
  };
  const serviceCalls: CliHarness['serviceCalls'] = [];

  vi.spyOn(console, 'log').mockImplementation((value = '') => {
    stdout.push(String(value));
  });
  vi.spyOn(console, 'error').mockImplementation((value = '') => {
    stderr.push(String(value));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });

  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    log: {
      error: vi.fn((message: string) => logs.error.push(String(message))),
      info: vi.fn((message: string) => logs.info.push(String(message))),
      success: vi.fn((message: string) => logs.success.push(String(message))),
      warn: vi.fn((message: string) => logs.warn.push(String(message))),
    },
    note: vi.fn((message: string, title?: string) => {
      notes.push({ message: String(message), title });
    }),
    outro: vi.fn((message: string) => logs.info.push(String(message))),
    select: vi.fn(async () => 'cancel'),
  }));
  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: vi.fn(() => ({
      getContainerConfig: vi.fn(async () => ({ env: {} })),
    })),
  }));
  vi.doMock('@core/config/preflight.js', async () => {
    const actual = await vi.importActual<any>('@core/config/preflight.js');
    return {
      ...actual,
      validateRuntimePreflightWithStorage: vi.fn(async () => ({
        ok: options?.preflightOk ?? true,
        failure:
          options?.preflightOk === false
            ? {
                code: 'storage_unavailable',
                message: 'Deterministic storage is unavailable.',
                details: [],
              }
            : undefined,
      })),
    };
  });
  vi.doMock('@core/infrastructure/service/manager.js', () => ({
    getServiceStatus: vi.fn((runtimeHome: string) => {
      serviceCalls.push({ action: 'status', runtimeHome });
      return {
        kind: 'background',
        status: options?.serviceStatus ?? 'not_running',
      };
    }),
    installService: vi.fn((_importMetaUrl: string, runtimeHome: string) => {
      serviceCalls.push({ action: 'install', runtimeHome });
      return {
        ok: true,
        kind: 'background',
        message: `Installed deterministic service in ${runtimeHome}.`,
      };
    }),
    startService: vi.fn((runtimeHome: string) => {
      serviceCalls.push({ action: 'start', runtimeHome });
      return {
        ok: true,
        kind: 'background',
        message: `Started deterministic service in ${runtimeHome}.`,
      };
    }),
    stopService: vi.fn((runtimeHome: string) => {
      serviceCalls.push({ action: 'stop', runtimeHome });
      return {
        ok: true,
        kind: 'background',
        message: `Stopped deterministic service in ${runtimeHome}.`,
      };
    }),
  }));

  const { main } = await import('@core/cli/index.js');

  return {
    runtimeHome: fixture.runtimeHome,
    stdout,
    stderr,
    notes,
    logs,
    serviceCalls,
    run(args) {
      return main(['--runtime-home', fixture.runtimeHome, ...args]);
    },
    readSettings() {
      return loadRuntimeSettings(fixture.runtimeHome);
    },
  };
}

describe('deterministic user CLI e2e flows', () => {
  const successfulConfigCases = [
    {
      name: 'sets and reads a runtime database URL without exposing the full secret by default',
      commands: [
        [
          'config',
          'set',
          'MYCLAW_DATABASE_URL',
          'postgres://user:pass@localhost/myclaw',
        ],
        ['config', 'get', 'MYCLAW_DATABASE_URL'],
      ],
      expected: 'pos***law',
    },
    {
      name: 'reads a runtime database URL in raw mode only when requested',
      commands: [
        [
          'config',
          'set',
          'MYCLAW_DATABASE_URL',
          'postgres://user:pass@localhost/myclaw',
        ],
        ['config', 'get', 'MYCLAW_DATABASE_URL', '--raw'],
      ],
      expected: 'postgres://user:pass@localhost/myclaw',
    },
    {
      name: 'stores a Telegram runtime token in the local runtime env lane',
      commands: [
        ['config', 'set', 'TELEGRAM_BOT_TOKEN', '123:telegram-token'],
        ['config', 'list'],
      ],
      expected: 'TELEGRAM_BOT_TOKEN=123***ken',
    },
    {
      name: 'stores Slack bot token as a runtime secret',
      commands: [
        ['config', 'set', 'SLACK_BOT_TOKEN', 'xoxb-runtime-token'],
        ['config', 'list'],
      ],
      expected: 'SLACK_BOT_TOKEN=xox***ken',
    },
    {
      name: 'stores Slack app token as a runtime secret',
      commands: [
        ['config', 'set', 'SLACK_APP_TOKEN', 'xapp-runtime-token'],
        ['config', 'list'],
      ],
      expected: 'SLACK_APP_TOKEN=xap***ken',
    },
    {
      name: 'stores Teams tenant id as runtime provider configuration',
      commands: [
        ['config', 'set', 'TEAMS_TENANT_ID', 'tenant-123'],
        ['config', 'get', 'TEAMS_TENANT_ID'],
      ],
      expected: 'tenant-123',
    },
    {
      name: 'stores Teams client id as runtime provider configuration',
      commands: [
        ['config', 'set', 'TEAMS_CLIENT_ID', 'client-123'],
        ['config', 'get', 'TEAMS_CLIENT_ID'],
      ],
      expected: 'client-123',
    },
    {
      name: 'masks Teams client secret when listed',
      commands: [
        ['config', 'set', 'TEAMS_CLIENT_SECRET', 'teams-client-secret'],
        ['config', 'list'],
      ],
      expected: 'TEAMS_CLIENT_SECRET=tea***ret',
    },
    {
      name: 'removes a runtime env key through unset',
      commands: [
        [
          'config',
          'set',
          'MYCLAW_DATABASE_URL',
          'postgres://user:pass@localhost/myclaw',
        ],
        ['config', 'unset', 'MYCLAW_DATABASE_URL'],
        ['config', 'list'],
      ],
      expected: 'No config keys found',
    },
    {
      name: 'shows top-level usage when global help is requested',
      commands: [['config', '--help']],
      expected: 'MyClaw CLI',
    },
  ] as const;

  it.each(successfulConfigCases)('$name', async (scenario) => {
    const cli = await createCliHarness();
    let code = 0;
    for (const command of scenario.commands) {
      code = await cli.run([...command]);
    }

    expect(code).toBe(0);
    const output = [...cli.stdout, ...cli.logs.warn, ...cli.logs.success].join(
      '\n',
    );
    expect(output).toContain(scenario.expected);
  });

  const rejectedConfigCases = [
    {
      name: 'rejects lowercase config keys',
      command: ['config', 'set', 'lowercase_key', 'value'],
      expected: 'Invalid key',
    },
    {
      name: 'rejects empty config values',
      command: ['config', 'set', 'MYCLAW_DATABASE_URL', ''],
      expected: 'Value cannot be empty',
    },
    {
      name: 'rejects direct Anthropic API keys in the runtime env lane',
      command: ['config', 'set', 'ANTHROPIC_API_KEY', 'sk-test'],
      expected: 'agent-accessed credential',
    },
    {
      name: 'rejects direct OpenAI API keys in the runtime env lane',
      command: ['config', 'set', 'OPENAI_API_KEY', 'sk-test'],
      expected: 'agent-accessed credential',
    },
    {
      name: 'rejects non-secret assistant naming in the runtime env lane',
      command: ['config', 'set', 'ASSISTANT_NAME', 'Clawy'],
      expected: 'settings.yaml agent.name',
    },
    {
      name: 'rejects missing config get key',
      command: ['config', 'get'],
      expected: 'Usage: myclaw config get',
    },
    {
      name: 'rejects missing config set value',
      command: ['config', 'set', 'MYCLAW_DATABASE_URL'],
      expected: 'Usage: myclaw config set',
    },
    {
      name: 'rejects unknown config subcommands',
      command: ['config', 'print'],
      expected: 'Unknown config command',
    },
  ] as const;

  it.each(rejectedConfigCases)('$name', async (scenario) => {
    const cli = await createCliHarness();
    const code = await cli.run([...scenario.command]);

    expect(code).toBe(1);
    expect([...cli.stderr, ...cli.logs.error].join('\n')).toContain(
      scenario.expected,
    );
  });

  const modelSetCases = [
    {
      name: 'sets the interactive chat default to Opus',
      command: ['model', 'set-default', 'chat', 'opus'],
      field: 'defaultModel',
      expected: 'opus',
    },
    {
      name: 'sets the interactive alias target to Sonnet',
      command: ['model', 'set-default', 'interactive', 'sonnet'],
      field: 'defaultModel',
      expected: 'sonnet',
    },
    {
      name: 'sets one-time job default through the one-time target',
      command: ['model', 'set-default', 'one-time', 'haiku'],
      field: 'oneTimeJobDefaultModel',
      expected: 'haiku',
    },
    {
      name: 'sets one-time job default through the once target',
      command: ['model', 'set-default', 'once', 'haiku-4.5'],
      field: 'oneTimeJobDefaultModel',
      expected: 'haiku',
    },
    {
      name: 'sets recurring job default to Kimi',
      command: ['model', 'set-default', 'recurring', 'kimi'],
      field: 'recurringJobDefaultModel',
      expected: 'kimi',
    },
    {
      name: 'normalizes spaced Kimi alias for chat jobs',
      command: ['model', 'set-default', 'chat', 'kimi 2.6'],
      field: 'defaultModel',
      expected: 'kimi',
    },
  ] as const;

  it.each(modelSetCases)('$name', async (scenario) => {
    const cli = await createCliHarness();
    const code = await cli.run([...scenario.command]);

    expect(code).toBe(0);
    expect(cli.readSettings().agent[scenario.field]).toBe(scenario.expected);
  });

  const modelReadCases = [
    {
      name: 'lists the provider-neutral model catalog',
      command: ['model', 'list'],
      expected: 'Opus 4.7',
      code: 0,
    },
    {
      name: 'reports model doctor pass for default settings',
      command: ['model', 'doctor'],
      expected: 'Status: pass',
      code: 0,
    },
    {
      name: 'reports OpenRouter credential warning when Kimi uses the default broker',
      before: [['model', 'set-default', 'chat', 'kimi']],
      command: ['model', 'doctor'],
      expected: 'OpenRouter credentials: warn',
      code: 0,
    },
    {
      name: 'rejects raw provider model ids at the user boundary',
      command: ['model', 'set-default', 'chat', 'claude-opus-4-7'],
      expected: 'Use a model alias',
      code: 1,
    },
    {
      name: 'rejects unknown model aliases',
      command: ['model', 'set-default', 'chat', 'unknown-model'],
      expected: 'Unknown model',
      code: 1,
    },
    {
      name: 'rejects unknown model target lanes',
      command: ['model', 'set-default', 'batch', 'opus'],
      expected: 'Usage:',
      code: 1,
    },
    {
      name: 'rejects incomplete model default commands',
      command: ['model', 'set-default', 'chat'],
      expected: 'Usage:',
      code: 1,
    },
  ] as const;

  it.each(modelReadCases)('$name', async (scenario) => {
    const cli = await createCliHarness();
    for (const command of scenario.before || []) {
      await cli.run([...command]);
    }
    const code = await cli.run([...scenario.command]);

    expect(code).toBe(scenario.code);
    expect([...cli.stdout, ...cli.stderr].join('\n')).toContain(
      scenario.expected,
    );
  });

  const memoryMutationCases = [
    {
      name: 'turns dreaming on and keeps memory enabled',
      command: ['memory', 'dreaming', 'on'],
      assert(settings: ReturnType<typeof loadRuntimeSettings>) {
        expect(settings.memory.enabled).toBe(true);
        expect(settings.memory.dreaming.enabled).toBe(true);
      },
    },
    {
      name: 'turns dreaming off without deleting memory settings',
      command: ['memory', 'dreaming', 'off'],
      assert(settings: ReturnType<typeof loadRuntimeSettings>) {
        expect(settings.memory.dreaming.enabled).toBe(false);
      },
    },
    {
      name: 'turns embeddings off through the off alias',
      command: ['memory', 'embeddings', 'off'],
      assert(settings: ReturnType<typeof loadRuntimeSettings>) {
        expect(settings.memory.embeddings.enabled).toBe(false);
        expect(settings.memory.embeddings.provider).toBe('disabled');
      },
    },
    {
      name: 'turns embeddings off through the disabled provider name',
      command: ['memory', 'embeddings', 'disabled'],
      assert(settings: ReturnType<typeof loadRuntimeSettings>) {
        expect(settings.memory.embeddings.enabled).toBe(false);
        expect(settings.memory.embeddings.provider).toBe('disabled');
      },
    },
    {
      name: 'sets memory extractor model through the catalog',
      command: ['memory', 'model', 'set', 'extractor', 'haiku'],
      assert(settings: ReturnType<typeof loadRuntimeSettings>) {
        expect(settings.memory.llm.models.extractor).toBe('haiku');
      },
    },
    {
      name: 'sets memory dreaming model through the catalog',
      command: ['memory', 'model', 'set', 'dreaming', 'sonnet'],
      assert(settings: ReturnType<typeof loadRuntimeSettings>) {
        expect(settings.memory.llm.models.dreaming).toBe('sonnet');
      },
    },
    {
      name: 'sets memory consolidation model through the catalog',
      command: ['memory', 'model', 'set', 'consolidation', 'opus'],
      assert(settings: ReturnType<typeof loadRuntimeSettings>) {
        expect(settings.memory.llm.models.consolidation).toBe('opus');
      },
    },
    {
      name: 'applies the cheap memory profile',
      command: ['memory', 'model', 'profile', 'cheap'],
      assert(settings: ReturnType<typeof loadRuntimeSettings>) {
        expect(settings.memory.llm.models.extractor).toBe('haiku');
      },
    },
    {
      name: 'applies the balanced memory profile',
      command: ['memory', 'model', 'profile', 'balanced'],
      assert(settings: ReturnType<typeof loadRuntimeSettings>) {
        expect(settings.memory.llm.models.dreaming).toBe('sonnet');
      },
    },
    {
      name: 'applies the quality memory profile',
      command: ['memory', 'model', 'profile', 'quality'],
      assert(settings: ReturnType<typeof loadRuntimeSettings>) {
        expect(settings.memory.llm.models.extractor).toBe('sonnet');
        expect(settings.memory.llm.models.consolidation).toBe('sonnet');
      },
    },
  ] as const;

  it.each(memoryMutationCases)('$name', async (scenario) => {
    const cli = await createCliHarness();
    const code = await cli.run([...scenario.command]);

    expect(code).toBe(0);
    scenario.assert(cli.readSettings());
  });

  const memoryReadAndRejectCases = [
    {
      name: 'renders human memory status without credentials',
      command: ['memory', 'status'],
      expected: 'MyClaw Memory',
      code: 0,
      source: 'notes',
    },
    {
      name: 'renders JSON memory status for automation',
      command: ['memory', 'status', '--json'],
      expected: '"memoryEnabled"',
      code: 0,
      source: 'stdout',
    },
    {
      name: 'rejects unknown embedding providers before any provider call',
      command: ['memory', 'embeddings', 'madeup'],
      expected: 'Unknown embedding provider',
      code: 1,
      source: 'logs',
    },
    {
      name: 'rejects malformed embedding provider names',
      command: ['memory', 'embeddings', '../bad'],
      expected: 'Usage:',
      code: 1,
      source: 'logs',
    },
    {
      name: 'rejects invalid dreaming values',
      command: ['memory', 'dreaming', 'maybe'],
      expected: 'Usage:',
      code: 1,
      source: 'logs',
    },
    {
      name: 'rejects invalid memory model tasks',
      command: ['memory', 'model', 'set', 'summary', 'haiku'],
      expected: 'Usage:',
      code: 1,
      source: 'logs',
    },
    {
      name: 'rejects raw provider ids for memory models',
      command: [
        'memory',
        'model',
        'set',
        'extractor',
        'claude-haiku-4-5-20251001',
      ],
      expected: 'Use a model alias',
      code: 1,
      source: 'logs',
    },
    {
      name: 'rejects unknown memory model profiles',
      command: ['memory', 'model', 'profile', 'fastest'],
      expected: 'Usage:',
      code: 1,
      source: 'logs',
    },
    {
      name: 'rejects unknown memory commands',
      command: ['memory', 'archive'],
      expected: 'Usage:',
      code: 1,
      source: 'logs',
    },
  ] as const;

  it.each(memoryReadAndRejectCases)('$name', async (scenario) => {
    const cli = await createCliHarness();
    const code = await cli.run([...scenario.command]);

    expect(code).toBe(scenario.code);
    const rendered =
      scenario.source === 'notes'
        ? cli.notes.map((note) => note.message).join('\n')
        : scenario.source === 'logs'
          ? cli.logs.error.join('\n')
          : cli.stdout.join('\n');
    expect(rendered).toContain(scenario.expected);
  });

  const providerCases = [
    {
      name: 'lists disabled providers without real provider calls',
      command: ['provider', 'list'],
      expected: 'disabled',
      code: 0,
      source: 'notes',
    },
    {
      name: 'shows configured Telegram credentials from isolated env only',
      env: { TELEGRAM_BOT_TOKEN: '123:telegram-token' },
      command: ['provider', 'list'],
      expected: 'Telegram: disabled | credentials: configured',
      code: 0,
      source: 'notes',
    },
    {
      name: 'shows configured Slack credentials from isolated env only',
      env: {
        SLACK_APP_TOKEN: 'xapp-test',
        SLACK_BOT_TOKEN: 'xoxb-test',
      },
      command: ['provider', 'list'],
      expected: 'Slack: disabled | credentials: configured',
      code: 0,
      source: 'notes',
    },
    {
      name: 'shows missing Teams credentials when isolated env is empty',
      command: ['provider', 'list'],
      expected: 'Teams: disabled | credentials: missing',
      code: 0,
      source: 'notes',
    },
    {
      name: 'rejects provider connect without a provider id',
      command: ['provider', 'connect'],
      expected: 'Usage:',
      code: 1,
      source: 'logs',
    },
    {
      name: 'rejects unknown provider ids',
      command: ['provider', 'connect', 'discord'],
      expected: 'Unknown provider',
      code: 1,
      source: 'logs',
    },
    {
      name: 'rejects the old channel command and points users at provider language',
      command: ['channel', 'list'],
      expected: 'Use `myclaw provider` or `myclaw conversation`.',
      code: 1,
      source: 'logs',
    },
  ] as const;

  it.each(providerCases)('$name', async (scenario) => {
    const cli = await createCliHarness({ env: scenario.env });
    const code = await cli.run([...scenario.command]);

    expect(code).toBe(scenario.code);
    const rendered =
      scenario.source === 'notes'
        ? cli.notes.map((note) => note.message).join('\n')
        : cli.logs.error.join('\n');
    expect(rendered).toContain(scenario.expected);
  });

  const browserCases = [
    {
      name: 'shows empty browser profile state for a fresh runtime home',
      setup: (_runtimeHome: string) => {},
      expected: 'No browser profiles found.',
    },
    {
      name: 'shows saved browser profile metadata without launching a browser',
      setup(runtimeHome: string) {
        const profile = path.join(runtimeHome, 'data/browser-profiles/work');
        fs.mkdirSync(path.join(profile, 'user-data'), { recursive: true });
        fs.writeFileSync(path.join(profile, 'user-data/state.json'), '{}');
        fs.writeFileSync(
          path.join(profile, 'profile.json'),
          JSON.stringify({
            last_used: '2026-05-04T00:00:00.000Z',
            auth_markers: ['github.com'],
          }),
        );
      },
      expected: 'signed-in sites: github.com',
    },
    {
      name: 'rejects unsupported browser subcommands',
      setup: (_runtimeHome: string) => {},
      command: ['browser', 'open'],
      expected: 'Usage: myclaw browser profiles',
      code: 1,
    },
  ] as const;

  it.each(browserCases)('$name', async (scenario) => {
    const cli = await createCliHarness();
    scenario.setup(cli.runtimeHome);
    const code = await cli.run([
      ...(scenario.command || ['browser', 'profiles']),
    ]);

    expect(code).toBe(scenario.code ?? 0);
    const rendered = [
      ...cli.notes.map((note) => note.message),
      ...cli.logs.error,
    ].join('\n');
    expect(rendered).toContain(scenario.expected);
  });

  const serviceCases = [
    {
      name: 'installs service metadata against the isolated runtime home',
      command: ['service', 'install'],
      expectedCalls: ['install'],
      code: 0,
    },
    {
      name: 'starts service through preflight and isolated service manager',
      command: ['service', 'start'],
      expectedCalls: ['start'],
      code: 0,
    },
    {
      name: 'stops service through the isolated service manager',
      command: ['service', 'stop'],
      expectedCalls: ['stop'],
      code: 0,
    },
    {
      name: 'restarts background services as stop then start',
      command: ['service', 'restart'],
      expectedCalls: ['status', 'stop', 'start'],
      code: 0,
    },
    {
      name: 'stops runtime from the top-level stop command',
      command: ['stop'],
      expectedCalls: ['stop'],
      code: 0,
    },
    {
      name: 'restarts runtime from the top-level restart command',
      command: ['restart'],
      expectedCalls: ['status', 'stop', 'start'],
      code: 0,
    },
    {
      name: 'rejects unknown service commands',
      command: ['service', 'reload'],
      expectedCalls: [],
      expectedError: 'Unknown service command',
      code: 1,
    },
    {
      name: 'blocks service start when deterministic preflight fails',
      command: ['service', 'start'],
      expectedCalls: [],
      code: 1,
      preflightOk: false,
    },
  ] as const;

  it.each(serviceCases)('$name', async (scenario) => {
    const cli = await createCliHarness({ preflightOk: scenario.preflightOk });
    const code = await cli.run([...scenario.command]);

    expect(code).toBe(scenario.code);
    expect(cli.serviceCalls.map((call) => call.action)).toEqual(
      scenario.expectedCalls,
    );
    expect(
      cli.serviceCalls.every((call) => call.runtimeHome === cli.runtimeHome),
    ).toBe(true);
    if (scenario.expectedError) {
      expect(cli.logs.error.join('\n')).toContain(scenario.expectedError);
    }
  });

  const generalCases = [
    {
      name: 'renders top-level help without creating provider credentials',
      command: ['--help'],
      expected: 'MyClaw CLI',
      code: 0,
    },
    {
      name: 'prints usage for unknown top-level commands',
      command: ['unknown-command'],
      expected: 'MyClaw CLI',
      code: 1,
    },
    {
      name: 'shows missing runtime logs without touching user logs',
      command: ['logs'],
      expected: '<log file not found>',
      code: 0,
      source: 'notes',
    },
    {
      name: 'tails runtime logs from the isolated runtime home',
      command: ['logs'],
      setup(runtimeHome: string) {
        fs.mkdirSync(path.join(runtimeHome, 'logs'), { recursive: true });
        fs.writeFileSync(
          path.join(runtimeHome, 'logs/myclaw.log'),
          'deterministic runtime log',
        );
      },
      expected: 'deterministic runtime log',
      code: 0,
      source: 'notes',
    },
  ] as const;

  it.each(generalCases)('$name', async (scenario) => {
    const cli = await createCliHarness();
    scenario.setup?.(cli.runtimeHome);
    const code = await cli.run([...scenario.command]);

    expect(code).toBe(scenario.code);
    const rendered =
      scenario.source === 'notes'
        ? cli.notes.map((note) => note.message).join('\n')
        : cli.stdout.join('\n');
    expect(rendered).toContain(scenario.expected);
  });
});
