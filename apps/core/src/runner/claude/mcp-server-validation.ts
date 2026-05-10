import fs from 'node:fs';

import type { McpServerConfig } from '../agent-capabilities.js';

export function readExternalMcpServers(): Record<string, McpServerConfig> {
  const configPath = process.env.MYCLAW_MCP_CONFIG_FILE?.trim();
  if (configPath) {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
      string,
      McpServerConfig
    >;
    fs.rmSync(configPath, { force: true });
    return validateExternalMcpServers(parsed);
  }
  const raw = process.env.MYCLAW_MCP_SERVERS_JSON?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, McpServerConfig>;
  return validateExternalMcpServers(parsed);
}

function validateExternalMcpServers(
  parsed: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(parsed)) {
    if (name === 'myclaw') {
      throw new Error(
        'Configured MCP servers cannot override the built-in myclaw server',
      );
    }
    if (isHostPrivateBrowserServerName(name)) {
      throw new Error(
        `${name} is host-private. Use the canonical Browser capability and MyClaw-owned browser_* tools.`,
      );
    }
    servers[name] = config;
  }
  return servers;
}

function isHostPrivateBrowserServerName(name: string): boolean {
  const normalized = name.trim().toLowerCase().replaceAll('-', '_');
  return (
    normalized === 'agent_browser' ||
    normalized === 'playwright' ||
    normalized === 'puppeteer'
  );
}
