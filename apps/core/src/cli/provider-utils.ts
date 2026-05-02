import '../channels/register-builtins.js';
import {
  listConnectableChannelProviders,
  providerForJid,
} from '../channels/provider-registry.js';
export type RuntimeProviderId = string;

export function getProviderIds(): RuntimeProviderId[] {
  return listConnectableChannelProviders().map((provider) => provider.id);
}

export function parseRuntimeProvider(raw: string): RuntimeProviderId | null {
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

export function providerFromGroupJid(jid: string): RuntimeProviderId | null {
  return providerForJid(jid)?.id ?? null;
}
