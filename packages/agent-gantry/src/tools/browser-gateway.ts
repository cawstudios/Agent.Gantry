import type {
  GantryAgentTool,
  GantryAgentToolContext,
  GantryBrowserGatewayActAction,
  GantryBrowserGatewayActRequest,
  GantryBrowserGatewayInspectMode,
  GantryBrowserGatewayInspectRequest,
  GantryBrowserGatewayOpenRequest,
  GantryBrowserGatewayRequest,
  GantryBrowserGatewayToolName,
  GantryBrowserGatewayToolProvider,
} from '../shared/types.js';
import { summarizeAgentObservation } from '../tasks/agent-task-runner.js';
import {
  asNonEmptyString,
  asRecord,
  readNumber,
  readString,
  readStringArray,
} from '../shared/helpers.js';

export function createGantryBrowserGatewayAgentTools(
  provider: GantryBrowserGatewayToolProvider,
): readonly GantryAgentTool[] {
  const makeRequest = (
    toolName: GantryBrowserGatewayToolName,
    input: Record<string, unknown>,
    context: GantryAgentToolContext,
  ): GantryBrowserGatewayRequest => ({
    toolName,
    correlationId:
      readString(input, 'correlationId') ?? context.correlationId ?? null,
    step: context.step,
    timeoutMs: readNumber(input, 'timeoutMs'),
    context,
  });

  const executeBrowserTool = async (
    toolName: GantryBrowserGatewayToolName,
    input: Record<string, unknown>,
    context: GantryAgentToolContext,
    execute: (
      request: GantryBrowserGatewayRequest,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    try {
      const result = await execute(makeRequest(toolName, input, context));
      rememberBrowserGatewayObservation(context, toolName, result);
      return result;
    } catch (error) {
      const result = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        toolName,
      };
      rememberBrowserGatewayObservation(context, toolName, result);
      return result;
    }
  };

  return [
    {
      name: 'browser_status',
      description:
        'Inspect whether the dedicated headed agent browser session is ready, without launching the scrape engine browser.',
      inputSchema: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (input, context) =>
        executeBrowserTool('browser_status', input, context, (request) =>
          provider.status(request),
        ),
    },
    {
      name: 'browser_open',
      description:
        'Launch or reuse the dedicated headed agent browser profile and optionally navigate it to a URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          profileKey: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (input, context) =>
        executeBrowserTool('browser_open', input, context, (request) =>
          provider.open({
            ...request,
            url: readString(input, 'url'),
            profileKey: readString(input, 'profileKey'),
          }),
        ),
    },
    {
      name: 'browser_inspect',
      description:
        'Inspect the current headed agent browser state: accessibility snapshot, screenshot, tabs, console, or network events.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['snapshot', 'screenshot', 'tabs', 'console', 'network'],
          },
          tabId: { type: 'string' },
          reason: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (input, context) =>
        executeBrowserTool('browser_inspect', input, context, (request) =>
          provider.inspect({
            ...request,
            mode: readBrowserInspectMode(input.mode),
            tabId: readString(input, 'tabId'),
            reason: readString(input, 'reason'),
          }),
        ),
    },
    {
      name: 'browser_act',
      description:
        'Perform one browser action in the headed agent browser, such as navigate, click, type, wait, select, tabs, dialog, or screenshot.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [
              'navigate',
              'back',
              'forward',
              'reload',
              'click',
              'type',
              'fill',
              'select',
              'wait',
              'keyboard',
              'screenshot',
              'tab_new',
              'tab_select',
              'tab_close',
              'dialog',
            ],
          },
          tabId: { type: 'string' },
          payload: { type: 'object' },
          reason: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (input, context) =>
        executeBrowserTool('browser_act', input, context, (request) =>
          provider.act({
            ...request,
            action: readBrowserActAction(input.action),
            tabId: readString(input, 'tabId'),
            payload: asRecord(input.payload) ?? {},
            reason: readString(input, 'reason'),
          }),
        ),
    },
    {
      name: 'browser_close',
      description:
        'Close only the dedicated agent browser session/profile. This must not close any scrape-runtime browser page.',
      inputSchema: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (input, context) =>
        executeBrowserTool('browser_close', input, context, (request) =>
          provider.close(request),
        ),
    },
  ];
}

function readBrowserInspectMode(
  value: unknown,
): GantryBrowserGatewayInspectMode {
  return value === 'screenshot' ||
    value === 'tabs' ||
    value === 'console' ||
    value === 'network'
    ? value
    : 'snapshot';
}

function readBrowserActAction(value: unknown): GantryBrowserGatewayActAction {
  const allowed = new Set<GantryBrowserGatewayActAction>([
    'navigate',
    'back',
    'forward',
    'reload',
    'click',
    'type',
    'fill',
    'select',
    'wait',
    'keyboard',
    'screenshot',
    'tab_new',
    'tab_select',
    'tab_close',
    'dialog',
  ]);
  return typeof value === 'string' &&
    allowed.has(value as GantryBrowserGatewayActAction)
    ? (value as GantryBrowserGatewayActAction)
    : 'wait';
}

function rememberBrowserGatewayObservation(
  context: GantryAgentToolContext,
  toolName: GantryBrowserGatewayToolName,
  observation: Record<string, unknown>,
): void {
  const existing = asRecord(context.state.browserGateway) ?? {};
  const screenshotRefs = [
    ...readStringArray(existing.screenshotRefs),
    ...collectBrowserGatewayScreenshotRefs(observation),
  ].slice(-12);
  const compactObservation = summarizeAgentObservation(observation);
  const isSnapshotObservation =
    readString(observation, 'mode') === 'snapshot' ||
    Boolean(asRecord(observation.selectorEvidence));
  const browserGateway = {
    ...existing,
    lastToolName: toolName,
    lastObservation: compactObservation,
    ...(isSnapshotObservation
      ? { lastSnapshotObservation: compactObservation }
      : {}),
    screenshotRefs,
  };
  context.state.browserGateway = browserGateway;
  const browserContext = asRecord(context.state.browserContext) ?? {};
  context.state.browserContext = {
    ...browserContext,
    gateway: browserGateway,
  };
}

function collectBrowserGatewayScreenshotRefs(
  observation: Record<string, unknown>,
): readonly string[] {
  const refs: string[] = [];
  const directRef = asNonEmptyString(observation.screenshotRef);
  if (directRef) refs.push(directRef);
  const screenshot = asRecord(observation.screenshot);
  const localPath =
    asNonEmptyString(screenshot?.localPath) ??
    asNonEmptyString(screenshot?.path);
  if (localPath)
    refs.push(
      localPath.startsWith('browser-screenshot:')
        ? localPath
        : `browser-screenshot:file:${localPath}`,
    );
  const artifacts = Array.isArray(observation.artifacts)
    ? observation.artifacts
    : [];
  for (const artifact of artifacts) {
    const record = asRecord(artifact);
    const path =
      asNonEmptyString(record?.localPath) ?? asNonEmptyString(record?.path);
    if (path)
      refs.push(
        path.startsWith('browser-screenshot:')
          ? path
          : `browser-screenshot:file:${path}`,
      );
  }
  return Array.from(new Set(refs));
}
