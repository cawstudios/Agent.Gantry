import '../channels/register-builtins.js';
import {
  listConnectableChannelProviders,
  providerForJid,
} from '../channels/provider-registry.js';
import { RuntimeChannel } from '../config/settings/runtime-settings.js';

export function getChannelIds(): RuntimeChannel[] {
  return listConnectableChannelProviders().map((provider) => provider.id);
}

export function parseRuntimeChannel(raw: string): RuntimeChannel | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (
    listConnectableChannelProviders().some(
      (provider) => provider.id === normalized,
    )
  ) {
    return normalized;
  }
  for (const provider of listConnectableChannelProviders()) {
    const shortPrefix = provider.jidPrefix.replace(/:$/, '').toLowerCase();
    if (normalized === shortPrefix) {
      return provider.id;
    }
  }
  return null;
}

export function channelFromGroupJid(jid: string): RuntimeChannel | null {
  return providerForJid(jid)?.id ?? null;
}
