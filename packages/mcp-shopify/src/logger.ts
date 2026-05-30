export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const SECRET_VALUE_PATTERN = /shp(?:at|ca|ss|ua|pa)_[A-Za-z0-9]+/g;
const SECRET_KEYS = new Set([
  'token',
  'accesstoken',
  'access_token',
  'client_secret',
  'clientsecret',
  'secret',
  'authorization',
  'phone',
  'email',
  'address',
  'x-caller-identity',
  'callerphone',
  'callerphoneraw',
  'calleremail',
  'identitysecret',
  'shopify_mcp_identity_secret',
]);

function redactValue(input: unknown): unknown {
  if (typeof input === 'string') {
    return input.replace(SECRET_VALUE_PATTERN, '[REDACTED_TOKEN]');
  }
  if (Array.isArray(input)) return input.map((v) => redactValue(v));
  if (input && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k.toLowerCase()) && typeof v === 'string') {
        result[k] = '[REDACTED]';
      } else {
        result[k] = redactValue(v);
      }
    }
    return result;
  }
  return input;
}

export interface Logger {
  debug(data: Record<string, unknown> | string, msg?: string): void;
  info(data: Record<string, unknown> | string, msg?: string): void;
  warn(data: Record<string, unknown> | string, msg?: string): void;
  error(data: Record<string, unknown> | string, msg?: string): void;
  fatal(data: Record<string, unknown> | string, msg?: string): void;
  child(context: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'json' | 'text';
  context?: Record<string, unknown>;
  sink?: (line: string) => void;
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level: LogLevel = opts.level ?? 'info';
  const minPriority = LEVEL_PRIORITY[level];
  const format = opts.format ?? 'json';
  const baseContext = opts.context ?? {};
  const sink = opts.sink ?? defaultSink;

  function log(
    target: LogLevel,
    data: Record<string, unknown> | string,
    msg?: string,
  ): void {
    if (LEVEL_PRIORITY[target] < minPriority) return;
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: target,
      pid: process.pid,
      ...baseContext,
    };
    if (typeof data === 'string') {
      record.message = data;
    } else {
      Object.assign(record, redactValue(data));
      if (msg) record.message = msg;
    }
    const safe = redactValue(record);
    sink(format === 'json' ? JSON.stringify(safe) : formatText(safe));
  }

  return {
    debug: (d, m) => log('debug', d, m),
    info: (d, m) => log('info', d, m),
    warn: (d, m) => log('warn', d, m),
    error: (d, m) => log('error', d, m),
    fatal: (d, m) => log('fatal', d, m),
    child: (extra) =>
      createLogger({
        level,
        format,
        sink,
        context: { ...baseContext, ...extra },
      }),
  };
}

function formatText(record: unknown): string {
  if (!record || typeof record !== 'object') return String(record);
  const obj = record as Record<string, unknown>;
  const ts = obj.timestamp ?? '';
  const lvl = (obj.level as string | undefined)?.toUpperCase() ?? 'INFO';
  const msg = obj.message ?? '';
  return `${ts} ${lvl} ${msg}`;
}
