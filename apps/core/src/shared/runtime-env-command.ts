export const RUNTIME_ENV_ASSIGNMENT_KEYS = new Set([
  'GODEBUG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'FTP_PROXY',
  'ftp_proxy',
  'RSYNC_PROXY',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PORT',
  'GRPC_PROXY',
  'grpc_proxy',
  'GIT_SSH_COMMAND',
  'NODE_USE_ENV_PROXY',
  'NO_PROXY',
  'no_proxy',
]);

export function stripRuntimeEnvPrefix(command: string): {
  command: string;
  envAssignments: string[];
} {
  const parsed = splitRuntimeEnvAssignments(command);
  if (!parsed || !parsed.command.trim()) {
    return { command, envAssignments: [] };
  }
  return {
    command: parsed.command.trim(),
    envAssignments: parsed.assignments,
  };
}

function splitRuntimeEnvAssignments(
  command: string,
): { command: string; assignments: string[] } | null {
  let offset = 0;
  const assignments: string[] = [];
  while (offset < command.length) {
    const next = parseRuntimeEnvAssignment(command, offset);
    if (!next) break;
    assignments.push(
      command.slice(skipSpaces(command, offset), next.nextOffset).trim(),
    );
    offset = next.nextOffset;
  }
  if (assignments.length === 0) return null;
  return { command: command.slice(offset), assignments };
}

function parseRuntimeEnvAssignment(
  command: string,
  offset: number,
): { nextOffset: number } | null {
  let cursor = skipSpaces(command, offset);
  const keyMatch = command.slice(cursor).match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (!keyMatch?.[1] || !RUNTIME_ENV_ASSIGNMENT_KEYS.has(keyMatch[1])) {
    return null;
  }
  cursor += keyMatch[0].length;
  const parsedValue = parseShellAssignmentValue(command, cursor);
  if (!parsedValue || parsedValue.nextOffset === cursor) return null;
  return { nextOffset: skipSpaces(command, parsedValue.nextOffset) };
}

function parseShellAssignmentValue(
  command: string,
  offset: number,
): { nextOffset: number } | null {
  const quote = command[offset];
  if (quote === "'" || quote === '"') {
    let cursor = offset + 1;
    while (cursor < command.length) {
      if (command[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (command[cursor] === quote) {
        return { nextOffset: cursor + 1 };
      }
      cursor += 1;
    }
    return null;
  }
  let cursor = offset;
  while (
    cursor < command.length &&
    !/[\s;|&<>()]/.test(command[cursor] ?? '')
  ) {
    cursor += 1;
  }
  return { nextOffset: cursor };
}

function skipSpaces(command: string, offset: number): number {
  let cursor = offset;
  while (cursor < command.length && /\s/.test(command[cursor] ?? '')) {
    cursor += 1;
  }
  return cursor;
}
