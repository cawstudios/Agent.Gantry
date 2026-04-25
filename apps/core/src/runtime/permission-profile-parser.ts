import type { ConfiguredAgent } from './agent-config-registry.js';
import type { AgentPermissionProfile } from './permission-profile-registry.js';

const CLI_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

function parseBoolean(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`expected boolean, received "${raw.trim()}"`);
}

function parseNumber(raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`expected non-negative integer, received "${raw.trim()}"`);
  }
  return value;
}

function parseInlineStringArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '[]') return [];
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error(`expected string array, received "${trimmed}"`);
  }
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  return body
    .split(',')
    .map((item) => unquote(item).trim())
    .filter((item) => item.length > 0);
}

function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== '\\') {
      quote = quote === char ? null : quote || char;
    }
    if (char === '#' && !quote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parsePermissionYaml(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: string | null = null;
  let nestedListKey: string | null = null;

  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const withoutComment = stripComment(lines[index]);
    if (!withoutComment.trim()) continue;
    if (withoutComment.includes('\t')) {
      throw new Error(`tabs are not supported (line ${index + 1})`);
    }

    const indent = withoutComment.match(/^ */)?.[0].length || 0;
    const trimmed = withoutComment.trim();

    if (indent === 0) {
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex <= 0) {
        throw new Error(`expected "key: value" mapping (line ${index + 1})`);
      }
      const key = unquote(trimmed.slice(0, colonIndex)).trim();
      const rest = trimmed.slice(colonIndex + 1).trim();
      nestedListKey = null;
      section = key;
      if (rest) {
        if (rest === 'true' || rest === 'false') {
          root[key] = parseBoolean(rest);
        } else if (rest.startsWith('[')) {
          root[key] = parseInlineStringArray(rest);
        } else {
          root[key] = unquote(rest);
        }
      } else if (key === 'allowed_clis') {
        root[key] = [];
      } else {
        root[key] = {};
      }
      continue;
    }

    if (!section) {
      throw new Error(
        `nested value without parent section (line ${index + 1})`,
      );
    }
    if (indent % 2 !== 0) {
      throw new Error(
        `indentation must be 2-space aligned (line ${index + 1})`,
      );
    }

    if (indent === 2 && trimmed.startsWith('- ')) {
      const current = root[section];
      if (!Array.isArray(current)) {
        throw new Error(`unexpected list item under "${section}"`);
      }
      current.push(unquote(trimmed.slice(2)).trim());
      continue;
    }

    if (indent === 2) {
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex <= 0) {
        throw new Error(`expected nested "key: value" (line ${index + 1})`);
      }
      const current = root[section];
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`section "${section}" must be a mapping`);
      }
      const key = unquote(trimmed.slice(0, colonIndex)).trim();
      const rest = trimmed.slice(colonIndex + 1).trim();
      const map = current as Record<string, unknown>;
      if (!rest) {
        map[key] = [];
        nestedListKey = key;
      } else if (section === 'tools') {
        map[key] = parseBoolean(rest);
        nestedListKey = null;
      } else if (section === 'rate_limits') {
        map[key] = parseNumber(rest);
        nestedListKey = null;
      } else if (rest.startsWith('[')) {
        map[key] = parseInlineStringArray(rest);
        nestedListKey = null;
      } else {
        map[key] = unquote(rest);
        nestedListKey = null;
      }
      continue;
    }

    if (indent === 4 && trimmed.startsWith('- ')) {
      const current = root[section];
      if (
        !nestedListKey ||
        !current ||
        typeof current !== 'object' ||
        Array.isArray(current)
      ) {
        throw new Error(`unexpected nested list item (line ${index + 1})`);
      }
      const list = (current as Record<string, unknown>)[nestedListKey];
      if (!Array.isArray(list)) {
        throw new Error(`invalid nested list state for "${nestedListKey}"`);
      }
      list.push(unquote(trimmed.slice(2)).trim());
      continue;
    }

    throw new Error(
      `unsupported nesting in permissions.yaml (line ${index + 1})`,
    );
  }

  return root;
}

function parsePermissionConfigText(raw: string): Record<string, unknown> {
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
  return parsePermissionYaml(raw);
}

function asObject(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function normalizeStringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value
    .map((item) => {
      if (typeof item !== 'string') {
        throw new Error(`${field} must contain only strings`);
      }
      return item.trim();
    })
    .filter((item) => item.length > 0);
}

function normalizeTools(value: unknown): Record<string, boolean> {
  const tools = asObject(value, 'tools') || {};
  const normalized: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(tools)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error('tools keys must be non-empty');
    }
    if (typeof raw !== 'boolean') {
      throw new Error(`tools.${normalizedKey} must be true/false`);
    }
    normalized[normalizedKey] = raw;
  }
  return normalized;
}

function normalizeAllowedClis(value: unknown): string[] {
  const items = normalizeStringList(value, 'allowed_clis');
  for (const item of items) {
    if (!CLI_PATTERN.test(item)) {
      throw new Error(`allowed_clis contains invalid command "${item}"`);
    }
  }
  return [...new Set(items)];
}

function normalizeChannelTargets(
  value: unknown,
): AgentPermissionProfile['allowedChannelTargets'] {
  const targets = asObject(value, 'allowed_channel_targets') || {};
  const normalized: AgentPermissionProfile['allowedChannelTargets'] = {};
  for (const [platform, rawTargets] of Object.entries(targets)) {
    const normalizedPlatform = platform.trim().toLowerCase();
    if (!normalizedPlatform) {
      throw new Error('allowed_channel_targets keys must be non-empty');
    }
    normalized[normalizedPlatform] = normalizeStringList(
      rawTargets,
      `allowed_channel_targets.${normalizedPlatform}`,
    );
  }
  return normalized;
}

function normalizeRateLimits(
  value: unknown,
): AgentPermissionProfile['rateLimits'] {
  const rawLimits = asObject(value, 'rate_limits') || {};
  const limits: AgentPermissionProfile['rateLimits'] = {};
  const messagesPerHour = rawLimits.messages_per_hour;
  if (messagesPerHour !== undefined) {
    if (
      typeof messagesPerHour !== 'number' ||
      !Number.isInteger(messagesPerHour) ||
      messagesPerHour < 0
    ) {
      throw new Error(
        'rate_limits.messages_per_hour must be a non-negative integer',
      );
    }
    limits.messagesPerHour = messagesPerHour;
  }
  const summariesPerHour = rawLimits.summaries_per_hour;
  if (summariesPerHour !== undefined) {
    if (
      typeof summariesPerHour !== 'number' ||
      !Number.isInteger(summariesPerHour) ||
      summariesPerHour < 0
    ) {
      throw new Error(
        'rate_limits.summaries_per_hour must be a non-negative integer',
      );
    }
    limits.summariesPerHour = summariesPerHour;
  }
  return limits;
}

export function normalizePermissionProfile(
  raw: string,
  agent: ConfiguredAgent,
  sourcePath: string,
): AgentPermissionProfile {
  const parsed = parsePermissionConfigText(raw);
  return {
    agentId: agent.id,
    folder: agent.folder,
    sourcePath,
    valid: true,
    tools: normalizeTools(parsed.tools),
    allowedClis: normalizeAllowedClis(parsed.allowed_clis),
    requireOnecli:
      typeof parsed.require_onecli === 'boolean' ? parsed.require_onecli : true,
    allowedChannelTargets: normalizeChannelTargets(
      parsed.allowed_channel_targets,
    ),
    rateLimits: normalizeRateLimits(parsed.rate_limits),
  };
}
