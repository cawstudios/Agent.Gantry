import dns from 'node:dns/promises';
import net from 'node:net';

export type ResolvedWebhookTarget = {
  url: URL;
  address: string;
  family: 4 | 6;
};

export function hostnameForNetwork(input: string): string {
  return input.startsWith('[') && input.endsWith(']')
    ? input.slice(1, -1)
    : input;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });
  return bytes.every((byte) => Number.isInteger(byte)) ? bytes : null;
}

function parseIpv6Bytes(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);

  const ipv4Match = /(.+:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  let ipv4Groups: number[] = [];
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[2]!);
    if (!ipv4) return null;
    normalized = `${ipv4Match[1]}${((ipv4[0]! << 8) | ipv4[1]!).toString(
      16,
    )}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
    ipv4Groups = ipv4;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (segment: string): number[] => {
    if (!segment) return [];
    return segment.split(':').map((part) => {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return Number.NaN;
      return parseInt(part, 16);
    });
  };
  const left = parseGroups(halves[0]!);
  const right = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (
    left.some((part) => !Number.isInteger(part)) ||
    right.some((part) => !Number.isInteger(part))
  ) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill(0), ...right];
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((group) => [group >> 8, group & 0xff]);
  if (ipv4Groups.length > 0) {
    bytes.splice(12, 4, ...ipv4Groups);
  }
  return bytes;
}

export function isPrivateAddress(address: string): boolean {
  const normalized = hostnameForNetwork(address).toLowerCase();
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    const [a, b, c] = ipv4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b! >= 64 && b! <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a! >= 224) return true;
    return false;
  }

  const bytes = parseIpv6Bytes(normalized);
  if (!bytes) return true;
  const allZero = bytes.every((byte) => byte === 0);
  if (allZero) return true;
  const loopback =
    bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (loopback) return true;
  const isMappedIpv4 =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (isMappedIpv4) {
    return isPrivateAddress(bytes.slice(12).join('.'));
  }
  if ((bytes[0]! & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01) {
    if (bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
    if (bytes[2] === 0x00 && bytes[3] === 0x02) return true;
    if (bytes[2] === 0x00 && (bytes[3]! & 0xf0) === 0x10) return true;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true;
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01
  ) {
    return true;
  }
  return false;
}

export async function validateWebhookTarget(
  targetUrl: string,
): Promise<ResolvedWebhookTarget> {
  const parsed = new URL(targetUrl);
  const allowInsecure =
    process.env.MYCLAW_CONTROL_ALLOW_INSECURE_WEBHOOKS === 'true';
  const allowPrivate =
    process.env.MYCLAW_CONTROL_ALLOW_PRIVATE_WEBHOOKS === 'true';
  const allowlist = new Set(
    (process.env.MYCLAW_CONTROL_WEBHOOK_ALLOWED_HOSTS || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!allowInsecure && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('Webhook URL must use https'), {
      code: 'INVALID_WEBHOOK_URL',
      statusCode: 400,
    });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('Webhook URL must not include credentials'), {
      code: 'INVALID_WEBHOOK_URL',
      statusCode: 400,
    });
  }
  const hostname = hostnameForNetwork(parsed.hostname).toLowerCase();
  if (allowlist.size > 0 && !allowlist.has(hostname)) {
    throw Object.assign(new Error('Webhook host is not allowlisted'), {
      code: 'WEBHOOK_HOST_DENIED',
      statusCode: 403,
    });
  }
  if (!allowPrivate) {
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw Object.assign(new Error('Webhook host must be publicly routable'), {
        code: 'WEBHOOK_HOST_DENIED',
        statusCode: 403,
      });
    }
    if (net.isIP(hostname) && isPrivateAddress(hostname)) {
      throw Object.assign(new Error('Webhook host must be publicly routable'), {
        code: 'WEBHOOK_HOST_DENIED',
        statusCode: 403,
      });
    }
    const records = await dns.lookup(hostname, { all: true });
    if (records.some((record) => isPrivateAddress(record.address))) {
      throw Object.assign(new Error('Webhook host must be publicly routable'), {
        code: 'WEBHOOK_HOST_DENIED',
        statusCode: 403,
      });
    }
    const publicRecord = records.find(
      (record) => !isPrivateAddress(record.address),
    );
    if (publicRecord) {
      return {
        url: parsed,
        address: publicRecord.address,
        family: publicRecord.family as 4 | 6,
      };
    }
  }
  if (net.isIP(hostname)) {
    return {
      url: parsed,
      address: hostname,
      family: net.isIP(hostname) as 4 | 6,
    };
  }
  const records = await dns.lookup(hostname, { all: true });
  const record = records[0];
  if (!record) {
    throw Object.assign(new Error('Webhook host did not resolve'), {
      code: 'WEBHOOK_HOST_DENIED',
      statusCode: 403,
    });
  }
  return {
    url: parsed,
    address: record.address,
    family: record.family as 4 | 6,
  };
}
