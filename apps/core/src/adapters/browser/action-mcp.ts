import { createRequire } from 'node:module';
import path from 'node:path';

import { applyAgentEgressNoProxyEnv } from '../../shared/no-proxy.js';

const require = createRequire(import.meta.url);

export const BROWSER_ACTION_MCP_PACKAGE_NAME = '@playwright/mcp';

export interface BrowserActionMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export const BROWSER_ACTION_TIMEOUT_MS = 30_000;

export function resolveBrowserActionMcpCliPath(): string {
  return path.join(
    path.dirname(
      require.resolve(`${BROWSER_ACTION_MCP_PACKAGE_NAME}/package.json`),
    ),
    'cli.js',
  );
}

export function createBrowserActionMcpServerConfig(
  cdpEndpoint: string,
  options: { outputDir?: string } = {},
): BrowserActionMcpServerConfig {
  const env: Record<string, string> = {
    PLAYWRIGHT_MCP_CDP_ENDPOINT: cdpEndpoint,
  };
  applyAgentEgressNoProxyEnv(env);

  return {
    command: process.execPath,
    args: [
      resolveBrowserActionMcpCliPath(),
      '--shared-browser-context',
      '--timeout-action',
      String(BROWSER_ACTION_TIMEOUT_MS),
      ...(options.outputDir ? ['--output-dir', options.outputDir] : []),
    ],
    env,
  };
}
