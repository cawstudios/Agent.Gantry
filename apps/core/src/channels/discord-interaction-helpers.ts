export const DISCORD_API_ROOT = 'https://discord.com/api/v10';
export const DISCORD_JID_PREFIX = 'dc:';

export function discordChannelIdFromJid(jid: string): string | null {
  const trimmed = jid.trim();
  if (!trimmed) return null;
  return trimmed.startsWith(DISCORD_JID_PREFIX)
    ? trimmed.slice(DISCORD_JID_PREFIX.length)
    : trimmed;
}

export function discordHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bot ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}
