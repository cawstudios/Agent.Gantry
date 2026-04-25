import fs from 'fs';
import path from 'path';

import { AGENTS_DIR } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  ConfiguredAgent,
  getConfiguredAgents,
} from './agent-config-registry.js';
import { normalizePermissionProfile } from './permission-profile-parser.js';

export interface AgentPermissionProfile {
  agentId: string;
  folder: string;
  sourcePath: string;
  valid: boolean;
  denyReason?: string;
  tools: Record<string, boolean>;
  allowedClis: string[];
  requireOnecli: boolean;
  allowedChannelTargets: Record<string, string[]>;
  rateLimits: {
    messagesPerHour?: number;
    summariesPerHour?: number;
  };
}

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

interface LoadPermissionProfilesOptions {
  agentsDir?: string;
  agents?: Record<string, ConfiguredAgent>;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
}

type PermissionProfilesByAgentId = Record<string, AgentPermissionProfile>;

let permissionProfilesByAgentId: PermissionProfilesByAgentId = {};
const rateLimitState = new Map<
  string,
  { windowStart: number; count: number }
>();

function makeDenyProfile(
  agent: ConfiguredAgent,
  sourcePath: string,
  denyReason: string,
): AgentPermissionProfile {
  return {
    agentId: agent.id,
    folder: agent.folder,
    sourcePath,
    valid: false,
    denyReason,
    tools: {},
    allowedClis: [],
    requireOnecli: true,
    allowedChannelTargets: {},
    rateLimits: {},
  };
}

function normalizeTarget(value: string): string {
  return value.trim().toLowerCase();
}

function inferChannelPlatform(jid: string): string {
  if (jid.startsWith('sl:')) return 'slack';
  if (jid.includes('@g.us') || jid.includes('@c.us')) return 'whatsapp';
  return 'generic';
}

function candidateChannelTargets(input: {
  jid: string;
  group?: { id?: string; name?: string; folder?: string };
}): Set<string> {
  const candidates = new Set<string>();
  const add = (value?: string) => {
    const normalized = normalizeTarget(value || '');
    if (!normalized) return;
    candidates.add(normalized);
    if (normalized.startsWith('sl:')) {
      candidates.add(normalized.slice(3));
    }
    if (!normalized.startsWith('#') && !normalized.startsWith('@')) {
      candidates.add(`#${normalized}`);
      candidates.add(`@${normalized}`);
    }
  };
  add(input.jid);
  add(input.group?.folder);
  add(input.group?.id);
  add(input.group?.name);
  return candidates;
}

function rateLimitKey(agentId: string, bucket: string): string {
  return `${agentId}:${bucket}`;
}

export function clearPermissionRateLimitStateForTest(): void {
  rateLimitState.clear();
}

export function getPermissionProfiles(): PermissionProfilesByAgentId {
  return { ...permissionProfilesByAgentId };
}

export function getPermissionProfileForAgent(
  agentIdOrFolder: string,
): AgentPermissionProfile | undefined {
  const direct = permissionProfilesByAgentId[agentIdOrFolder];
  if (direct) return direct;
  return Object.values(permissionProfilesByAgentId).find(
    (profile) => profile.folder === agentIdOrFolder,
  );
}

export function checkPermissionRateLimit(
  profile: AgentPermissionProfile,
  bucket: keyof AgentPermissionProfile['rateLimits'],
  nowMs = Date.now(),
): PermissionDecision {
  const limit = profile.rateLimits[bucket];
  if (limit === undefined) return { allowed: true };
  if (limit <= 0) {
    return { allowed: false, reason: `${bucket} rate limit is 0` };
  }

  const key = rateLimitKey(profile.agentId, bucket);
  const windowMs = 60 * 60 * 1000;
  const current = rateLimitState.get(key);
  if (!current || nowMs - current.windowStart >= windowMs) {
    rateLimitState.set(key, { windowStart: nowMs, count: 1 });
    return { allowed: true };
  }
  if (current.count >= limit) {
    return { allowed: false, reason: `${bucket} rate limit exceeded` };
  }
  current.count += 1;
  return { allowed: true };
}

export function checkChannelSendPermission(
  profile: AgentPermissionProfile | undefined,
  input: {
    jid: string;
    group?: { name?: string; folder?: string };
    platform?: string;
    nowMs?: number;
  },
): PermissionDecision {
  if (!profile) return { allowed: true };
  if (!profile.valid) {
    return {
      allowed: false,
      reason: profile.denyReason || 'permission profile is invalid',
    };
  }
  if (profile.tools.message_send !== true) {
    return { allowed: false, reason: 'message_send is not allowed' };
  }

  const platform = (input.platform || inferChannelPlatform(input.jid))
    .trim()
    .toLowerCase();
  const allowedTargets = (profile.allowedChannelTargets[platform] || []).map(
    normalizeTarget,
  );
  if (allowedTargets.length === 0) {
    return {
      allowed: false,
      reason: `no ${platform} channel targets are allowed`,
    };
  }

  const candidates = candidateChannelTargets({
    jid: input.jid,
    group: input.group,
  });
  if (!allowedTargets.some((target) => candidates.has(target))) {
    return {
      allowed: false,
      reason: `${platform} target ${input.jid} is not allowed`,
    };
  }

  return checkPermissionRateLimit(
    profile,
    'messagesPerHour',
    input.nowMs ?? Date.now(),
  );
}

export function refreshPermissionProfilesFromDisk(
  options: LoadPermissionProfilesOptions = {},
): PermissionProfilesByAgentId {
  const agents = options.agents || getConfiguredAgents();
  const agentsDir = options.agentsDir || AGENTS_DIR;
  const log = options.logger || logger;
  const nextProfiles: PermissionProfilesByAgentId = {};

  for (const agent of Object.values(agents)) {
    const sourcePath = path.join(agentsDir, agent.folder, 'permissions.yaml');
    if (!fs.existsSync(sourcePath)) {
      nextProfiles[agent.id] = makeDenyProfile(
        agent,
        sourcePath,
        'permissions.yaml is missing',
      );
      log.warn(
        { agentId: agent.id, sourcePath },
        'Permission profile missing; using deny-by-default policy',
      );
      continue;
    }

    try {
      const raw = fs.readFileSync(sourcePath, 'utf-8');
      nextProfiles[agent.id] = normalizePermissionProfile(
        raw,
        agent,
        sourcePath,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      nextProfiles[agent.id] = makeDenyProfile(agent, sourcePath, message);
      log.warn(
        { agentId: agent.id, sourcePath, err },
        'Permission profile invalid; using deny-by-default policy',
      );
    }
  }

  permissionProfilesByAgentId = nextProfiles;
  log.info(
    {
      count: Object.keys(permissionProfilesByAgentId).length,
      ids: Object.keys(permissionProfilesByAgentId),
      invalidIds: Object.values(permissionProfilesByAgentId)
        .filter((profile) => !profile.valid)
        .map((profile) => profile.agentId),
    },
    'Loaded agent permission profiles',
  );
  return getPermissionProfiles();
}
