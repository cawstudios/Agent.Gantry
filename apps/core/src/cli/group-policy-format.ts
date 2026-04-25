import type {
  RuntimeChannel,
  RuntimeSettings,
} from '../config/settings/runtime-settings.js';

function renderAllow(allow: '*' | string[]): string {
  if (allow === '*') return '*';
  return allow.length > 0 ? allow.join(',') : '(none)';
}

export function printPolicyChannel(
  channel: RuntimeChannel,
  settings: RuntimeSettings,
): void {
  const channelSettings = settings.channels[channel];
  const policy = channelSettings.senderAllowlist;
  const lines = [
    `${channel}:`,
    `  enabled: ${channelSettings.enabled ? 'yes' : 'no'}`,
    `  default: allow=${renderAllow(policy.default.allow)} mode=${policy.default.mode}`,
    `  log_denied: ${policy.logDenied ? 'true' : 'false'}`,
    '  agents:',
  ];
  const entries = Object.entries(policy.agents).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    lines.push('    (none)');
  } else {
    for (const [folder, entry] of entries) {
      lines.push(
        `    ${folder}: allow=${renderAllow(entry.allow)} mode=${entry.mode}`,
      );
    }
  }
  console.log(lines.join('\n'));
}
