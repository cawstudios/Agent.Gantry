import { MYCLAW_HOME } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import '../channels/register-builtins.js';
import { loadRuntimeSettingsFromPath } from '../config/settings/runtime-settings.js';
import type { SenderControlAllowlistConfig } from '../config/settings/control-allowlist.js';
import type {
  ChatAllowlistEntry,
  SenderAllowlistConfig,
} from '../config/settings/sender-allowlist.js';
import { settingsFilePath } from '../config/settings/runtime-home.js';
import {
  listChannelProviders,
  providerForJid,
} from '../channels/provider-registry.js';

export type RuntimeSenderAllowlistConfig = Record<
  string,
  SenderAllowlistConfig
>;
export type RuntimeSenderControlAllowlistConfig = Record<
  string,
  SenderControlAllowlistConfig
>;

const DEFAULT_CHANNEL_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  agents: {},
  logDenied: true,
};
const DEFAULT_CONTROL_CHANNEL_CONFIG: SenderControlAllowlistConfig = {
  default: [],
  agents: {},
};

const DEFAULT_ENTRY: ChatAllowlistEntry = {
  allow: [],
  mode: 'drop',
};

function cloneDefaultChannelConfig(): SenderAllowlistConfig {
  return {
    default: { ...DEFAULT_CHANNEL_CONFIG.default },
    agents: {},
    logDenied: DEFAULT_CHANNEL_CONFIG.logDenied,
  };
}

function createDefaultConfig(): RuntimeSenderAllowlistConfig {
  const cfg: RuntimeSenderAllowlistConfig = {};
  for (const provider of listChannelProviders()) {
    cfg[provider.id] = cloneDefaultChannelConfig();
  }
  return cfg;
}

function cloneDefaultControlChannelConfig(): SenderControlAllowlistConfig {
  return {
    default: [...DEFAULT_CONTROL_CHANNEL_CONFIG.default],
    agents: {},
  };
}

function createDefaultControlConfig(): RuntimeSenderControlAllowlistConfig {
  const cfg: RuntimeSenderControlAllowlistConfig = {};
  for (const provider of listChannelProviders()) {
    cfg[provider.id] = cloneDefaultControlChannelConfig();
  }
  return cfg;
}

function getChannelConfig(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
): SenderAllowlistConfig | undefined {
  const channelId = providerForJid(chatJid)?.id;
  if (!channelId) return undefined;
  return cfg[channelId];
}

function getControlChannelConfig(
  chatJid: string,
  cfg: RuntimeSenderControlAllowlistConfig,
): SenderControlAllowlistConfig | undefined {
  const channelId = providerForJid(chatJid)?.id;
  if (!channelId) return undefined;
  return cfg[channelId];
}

export function loadSenderAllowlist(
  settingsPathOverride?: string,
): RuntimeSenderAllowlistConfig {
  const filePath = settingsPathOverride ?? settingsFilePath(MYCLAW_HOME);

  try {
    const settings = loadRuntimeSettingsFromPath(filePath);
    const cfg = createDefaultConfig();
    for (const [channelId, channelSettings] of Object.entries(
      settings.channels,
    )) {
      cfg[channelId] = channelSettings.senderAllowlist;
    }
    return cfg;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return createDefaultConfig();
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        path: filePath,
      },
      'sender-allowlist: invalid settings.yaml; using defaults',
    );
    return createDefaultConfig();
  }
}

export function loadSenderControlAllowlist(
  settingsPathOverride?: string,
): RuntimeSenderControlAllowlistConfig {
  const filePath = settingsPathOverride ?? settingsFilePath(MYCLAW_HOME);

  try {
    const settings = loadRuntimeSettingsFromPath(filePath);
    const cfg = createDefaultControlConfig();
    for (const [channelId, channelSettings] of Object.entries(
      settings.channels,
    )) {
      cfg[channelId] = channelSettings.controlAllowlist;
    }
    return cfg;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return createDefaultControlConfig();
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        path: filePath,
      },
      'sender-control-allowlist: invalid settings.yaml; using defaults',
    );
    return createDefaultControlConfig();
  }
}

function getEntry(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
  groupFolder?: string,
): ChatAllowlistEntry {
  const channelCfg = getChannelConfig(chatJid, cfg);
  if (!channelCfg) return DEFAULT_ENTRY;
  if (groupFolder) {
    const byAgent = channelCfg.agents[groupFolder];
    if (byAgent) return byAgent;
  }
  return channelCfg.default;
}

function getControlSenders(
  chatJid: string,
  cfg: RuntimeSenderControlAllowlistConfig,
  groupFolder?: string,
): string[] {
  const channelCfg = getControlChannelConfig(chatJid, cfg);
  if (!channelCfg) return [];
  if (groupFolder) {
    const byAgent = channelCfg.agents[groupFolder];
    if (byAgent) return byAgent;
  }
  return channelCfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: RuntimeSenderAllowlistConfig,
  groupFolder?: string,
): boolean {
  const entry = getEntry(chatJid, cfg, groupFolder);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function isSenderExplicitlyAllowed(
  chatJid: string,
  sender: string,
  cfg: RuntimeSenderAllowlistConfig,
  groupFolder?: string,
): boolean {
  const entry = getEntry(chatJid, cfg, groupFolder);
  if (entry.allow === '*') return false;
  return entry.allow.includes(sender);
}

export function isSenderControlAllowed(
  chatJid: string,
  sender: string,
  cfg: RuntimeSenderControlAllowlistConfig,
  groupFolder?: string,
): boolean {
  return getControlSenders(chatJid, cfg, groupFolder).includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
  groupFolder?: string,
): boolean {
  return getEntry(chatJid, cfg, groupFolder).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: RuntimeSenderAllowlistConfig,
  groupFolder?: string,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg, groupFolder);
  if (!allowed && shouldLogDenied(chatJid, cfg)) {
    logger.debug(
      { chatJid, sender, groupFolder },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}

export function shouldLogDenied(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
): boolean {
  return getChannelConfig(chatJid, cfg)?.logDenied ?? true;
}
