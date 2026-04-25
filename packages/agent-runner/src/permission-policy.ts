export interface RunnerPermissionProfile {
  agentId: string;
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

export interface RunnerPermissionDecision {
  allowed: boolean;
  reason?: string;
}

const rateLimitState = new Map<
  string,
  { windowStart: number; count: number }
>();

function normalizeToolKey(toolName: string): string {
  if (toolName === 'Bash') return 'bash';
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return 'web';
  if (toolName === 'mcp__myclaw__send_message') return 'message_send';
  if (toolName === 'mcp__myclaw__ask_user_question') return 'message_read';
  if (toolName.startsWith('mcp__myclaw__')) {
    return toolName.slice('mcp__myclaw__'.length);
  }
  return toolName.trim().toLowerCase();
}

function readCommand(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command.trim() : '';
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if ((char === '"' || char === "'") && command[index - 1] !== '\\') {
      quote = quote === char ? null : quote || char;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function commandSegments(command: string): string[] {
  return command
    .split(/\s+(?:&&|\|\||;|\|)\s+|\s*(?:&&|\|\||;|\|)\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function extractCliCommand(segment: string): {
  command: string;
  wrappedByOnecli: boolean;
} | null {
  const words = shellWords(segment);
  if (words.length === 0) return null;
  if (words[0] === 'onecli' && words[1] === 'exec' && words[2] === '--') {
    return words[3] ? { command: words[3], wrappedByOnecli: true } : null;
  }
  return { command: words[0], wrappedByOnecli: false };
}

function checkRateLimit(
  profile: RunnerPermissionProfile,
  bucket: keyof RunnerPermissionProfile['rateLimits'],
  nowMs: number,
): RunnerPermissionDecision {
  const limit = profile.rateLimits[bucket];
  if (limit === undefined) return { allowed: true };
  if (limit <= 0)
    return { allowed: false, reason: `${bucket} rate limit is 0` };

  const key = `${profile.agentId}:${bucket}`;
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

function checkBashCommand(
  profile: RunnerPermissionProfile,
  input: unknown,
): RunnerPermissionDecision {
  const command = readCommand(input);
  if (!command) {
    return { allowed: false, reason: 'Bash command is missing' };
  }

  const allowedClis = new Set(profile.allowedClis);
  if (allowedClis.size === 0) {
    return { allowed: false, reason: 'no CLI commands are allowed' };
  }

  for (const segment of commandSegments(command)) {
    const cli = extractCliCommand(segment);
    if (!cli) {
      return { allowed: false, reason: 'CLI command is missing' };
    }
    if (!allowedClis.has(cli.command)) {
      return { allowed: false, reason: `CLI ${cli.command} is not allowed` };
    }
    if (profile.requireOnecli && !cli.wrappedByOnecli) {
      return {
        allowed: false,
        reason: `CLI ${cli.command} must run through onecli exec --`,
      };
    }
  }

  return { allowed: true };
}

export function clearRunnerPermissionRateLimitStateForTest(): void {
  rateLimitState.clear();
}

export function checkRunnerToolPermission(
  profile: RunnerPermissionProfile | undefined,
  toolName: string,
  input: unknown,
  nowMs = Date.now(),
): RunnerPermissionDecision {
  if (!profile) return { allowed: true };
  if (!profile.valid) {
    return {
      allowed: false,
      reason: profile.denyReason || 'permission profile is invalid',
    };
  }

  const toolKey = normalizeToolKey(toolName);
  if (profile.tools[toolKey] !== true) {
    return { allowed: false, reason: `${toolKey} is not allowed` };
  }

  if (toolKey === 'bash') {
    return checkBashCommand(profile, input);
  }
  if (toolKey === 'message_send') {
    return checkRateLimit(profile, 'messagesPerHour', nowMs);
  }

  return { allowed: true };
}
