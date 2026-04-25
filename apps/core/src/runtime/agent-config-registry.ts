import fs from 'fs';
import path from 'path';

import { AGENTS_DIR } from '../core/config.js';
import { isValidTimezone } from '../core/timezone.js';
import { logger } from '../core/logger.js';
import { isValidGroupFolder } from '../platform/group-folder.js';

type AgentChannel = 'slack';

export interface ConfiguredAgent {
  id: string;
  folder: string;
  sourcePath: string;
  channel: AgentChannel;
  timezone: string;
  managerTarget?: string;
  rosterSource?: string;
  channelJids: string[];
  enabledWorkflows: string[];
}

interface LoadAgentRegistryOptions {
  agentsDir?: string;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
let configuredAgentsById: Record<string, ConfiguredAgent> = {};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseStringArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '[]') return [];
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  return body
    .split(',')
    .map((item) => unquote(item))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[') && value.endsWith(']')) {
    return parseStringArray(value);
  }
  return unquote(value);
}

function parseAgentYaml(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let listKey: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('#')) continue;
    if (line.includes('\t')) {
      throw new Error(`tabs are not supported (line ${index + 1})`);
    }

    const indent = line.match(/^ */)?.[0].length || 0;
    const trimmed = line.trim();

    if (indent === 0) {
      if (trimmed.startsWith('- ')) {
        throw new Error(`unexpected list item at root (line ${index + 1})`);
      }

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex <= 0) {
        throw new Error(`expected "key: value" mapping (line ${index + 1})`);
      }

      const key = unquote(trimmed.slice(0, colonIndex)).trim();
      if (!key) {
        throw new Error(`missing key before ':' (line ${index + 1})`);
      }

      const rest = trimmed.slice(colonIndex + 1).trim();
      if (!rest) {
        root[key] = [];
        listKey = key;
      } else {
        root[key] = parseScalar(rest);
        listKey = null;
      }
      continue;
    }

    if (indent % 2 !== 0) {
      throw new Error(
        `indentation must be 2-space aligned (line ${index + 1})`,
      );
    }
    if (!listKey) {
      throw new Error(
        `nested mappings are not supported in agent.yaml (line ${index + 1})`,
      );
    }
    if (!trimmed.startsWith('- ')) {
      throw new Error(`expected list item "- value" (line ${index + 1})`);
    }

    const current = root[listKey];
    if (!Array.isArray(current)) {
      throw new Error(`invalid list state for key "${listKey}"`);
    }
    const item = unquote(trimmed.slice(2)).trim();
    if (!item) {
      throw new Error(
        `empty list item for key "${listKey}" (line ${index + 1})`,
      );
    }
    current.push(item);
  }

  return root;
}

function parseAgentConfigText(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('file is empty');
  }
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root must be a mapping');
    }
    return parsed as Record<string, unknown>;
  }
  return parseAgentYaml(raw);
}

function assertAgentId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('id must be a string');
  }
  const next = value.trim();
  if (!AGENT_ID_PATTERN.test(next)) {
    throw new Error('id must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/');
  }
  return next;
}

function assertChannel(value: unknown): AgentChannel {
  if (typeof value !== 'string') {
    throw new Error('channel must be a string');
  }
  const next = value.trim().toLowerCase();
  if (next !== 'slack') {
    throw new Error('channel must be "slack" for phase 1');
  }
  return 'slack';
}

function assertTimezone(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('timezone must be a string');
  }
  const next = value.trim();
  if (!next || !isValidTimezone(next)) {
    throw new Error(
      `timezone must be a valid IANA timezone (received "${next}")`,
    );
  }
  return next;
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const next = value.trim();
  return next || undefined;
}

function parseEnabledWorkflows(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('enabled_workflows must be an array of strings');
  }
  return value
    .map((item) => {
      if (typeof item !== 'string') {
        throw new Error('enabled_workflows must contain only strings');
      }
      return item.trim();
    })
    .filter((item) => item.length > 0);
}

function parseChannelJids(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('channel_jids must be an array of strings');
  }
  const seen = new Set<string>();
  const jids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error('channel_jids must contain only strings');
    }
    const jid = item.trim();
    if (!jid) continue;
    if (!seen.has(jid)) {
      seen.add(jid);
      jids.push(jid);
    }
  }
  return jids;
}

function validateAgentConfig(
  parsed: Record<string, unknown>,
  context: { folder: string; sourcePath: string },
): ConfiguredAgent {
  const id = assertAgentId(parsed.id);
  const channel = assertChannel(parsed.channel);
  const timezone = assertTimezone(parsed.timezone);
  const enabledWorkflows = parseEnabledWorkflows(parsed.enabled_workflows);
  const channelJids = parseChannelJids(parsed.channel_jids);

  return {
    id,
    folder: context.folder,
    sourcePath: context.sourcePath,
    channel,
    timezone,
    managerTarget: optionalTrimmedString(parsed.manager_target),
    rosterSource: optionalTrimmedString(parsed.roster_source),
    channelJids,
    enabledWorkflows,
  };
}

export function getConfiguredAgents(): Record<string, ConfiguredAgent> {
  return { ...configuredAgentsById };
}

export function refreshConfiguredAgentsFromDisk(
  options: LoadAgentRegistryOptions = {},
): Record<string, ConfiguredAgent> {
  const agentsDir = options.agentsDir || AGENTS_DIR;
  const log = options.logger || logger;
  const nextAgentsById: Record<string, ConfiguredAgent> = {};

  if (!fs.existsSync(agentsDir)) {
    configuredAgentsById = {};
    log.info(
      { agentsDir },
      'Agent config directory missing; using empty registry',
    );
    return getConfiguredAgents();
  }

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = entry.name.trim();
    if (!isValidGroupFolder(folder)) {
      log.warn(
        { folder },
        'Skipping invalid agent folder name while loading config',
      );
      continue;
    }

    const sourcePath = path.join(agentsDir, folder, 'agent.yaml');
    if (!fs.existsSync(sourcePath)) continue;

    const raw = fs.readFileSync(sourcePath, 'utf-8');
    let validated: ConfiguredAgent;
    try {
      const parsed = parseAgentConfigText(raw);
      validated = validateAgentConfig(parsed, { folder, sourcePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid agent config "${sourcePath}": ${message}`);
    }

    const duplicate = nextAgentsById[validated.id];
    if (duplicate) {
      throw new Error(
        `Duplicate agent id "${validated.id}" in "${sourcePath}" and "${duplicate.sourcePath}"`,
      );
    }

    for (const jid of validated.channelJids) {
      const duplicateBinding = Object.values(nextAgentsById).find((agent) =>
        agent.channelJids.includes(jid),
      );
      if (duplicateBinding) {
        throw new Error(
          `Duplicate channel_jids entry "${jid}" in "${sourcePath}" and "${duplicateBinding.sourcePath}"`,
        );
      }
    }
    nextAgentsById[validated.id] = validated;
  }

  configuredAgentsById = nextAgentsById;
  log.info(
    {
      count: Object.keys(configuredAgentsById).length,
      ids: Object.keys(configuredAgentsById),
      agentsDir,
    },
    'Loaded config-driven agent registry',
  );
  return getConfiguredAgents();
}
