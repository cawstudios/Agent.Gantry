import { ChannelFactory } from './channel-provider.js';

export interface ChannelProviderSetupContext {
  runtimeHome: string;
  prompt: (question: string) => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
}

export interface ChannelProviderSetup {
  envKeys: readonly string[];
  describe: () => string;
  run: (ctx: ChannelProviderSetupContext) => Promise<void>;
}

export interface ChannelProviderSettingsLike {
  channels: Record<string, { enabled: boolean }>;
}

export type ChannelFormattingDialect =
  | 'none'
  | 'markdown-native'
  | 'mrkdwn'
  | 'telegram-html';

export interface ChannelProvider {
  id: string;
  label: string;
  internal?: boolean;
  jidPrefix: string;
  folderPrefix: string;
  isGroupJid: (jid: string) => boolean;
  formatting: ChannelFormattingDialect;
  isEnabled: (settings: ChannelProviderSettingsLike) => boolean;
  create: ChannelFactory;
  setup: ChannelProviderSetup;
}

const registry = new Map<string, ChannelProvider>();
let providersByJidPrefix: ChannelProvider[] = [];

function rebuildProviderPrefixCache(): void {
  providersByJidPrefix = [...registry.values()].sort(
    (a, b) => b.jidPrefix.length - a.jidPrefix.length,
  );
}

export function registerChannelProvider(provider: ChannelProvider): void {
  if (!provider.id.trim()) {
    throw new Error('Channel provider id must be non-empty');
  }
  if (!provider.jidPrefix.trim()) {
    throw new Error(
      `Channel provider "${provider.id}" jidPrefix must be non-empty`,
    );
  }
  if (!provider.folderPrefix.trim()) {
    throw new Error(
      `Channel provider "${provider.id}" folderPrefix must be non-empty`,
    );
  }

  if (registry.has(provider.id)) {
    throw new Error(`Duplicate channel provider id: ${provider.id}`);
  }

  for (const existing of registry.values()) {
    if (
      provider.jidPrefix.startsWith(existing.jidPrefix) ||
      existing.jidPrefix.startsWith(provider.jidPrefix)
    ) {
      throw new Error(
        `Channel provider jidPrefix overlap: "${provider.id}" (${provider.jidPrefix}) conflicts with "${existing.id}" (${existing.jidPrefix})`,
      );
    }
  }

  registry.set(provider.id, provider);
  rebuildProviderPrefixCache();
}

export function getChannelProvider(id: string): ChannelProvider | undefined {
  return registry.get(id);
}

export function listChannelProviders(): readonly ChannelProvider[] {
  return Array.from(registry.values());
}

export function listConnectableChannelProviders(): readonly ChannelProvider[] {
  return listChannelProviders().filter(
    (provider) => provider.internal !== true,
  );
}

export function providerForJid(jid: string): ChannelProvider | undefined {
  for (const provider of providersByJidPrefix) {
    if (jid.startsWith(provider.jidPrefix)) {
      return provider;
    }
  }
  return undefined;
}
