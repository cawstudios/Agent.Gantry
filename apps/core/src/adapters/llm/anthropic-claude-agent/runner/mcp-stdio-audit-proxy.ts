import { appendFileSync } from 'node:fs';
import { spawnTransparentStdioChild } from '../../../sandbox/transparent-stdio-child.js';
import {
  hashMcpAuditValue,
  projectMcpEvidence,
  summarizeMcpToolArgumentPayload,
} from '../../../../application/mcp/mcp-tool-audit.js';
import {
  createJsonRpcFrameObserver,
  type ExternalMcpAuditRecord,
} from './mcp-stdio-audit.js';

const auditFile = process.env.GANTRY_MCP_STDIO_AUDIT_FILE;
const serverName = process.env.GANTRY_MCP_STDIO_AUDIT_SERVER_NAME;
const command = process.argv[2];
const args = process.argv.slice(3);

if (!auditFile || !serverName || !command) {
  throw new Error('Invalid stdio MCP audit proxy configuration.');
}

const childEnv = { ...process.env };
delete childEnv.GANTRY_MCP_STDIO_AUDIT_FILE;
delete childEnv.GANTRY_MCP_STDIO_AUDIT_SERVER_NAME;

const child = spawnTransparentStdioChild(command, args, childEnv);
const pending = new Map<
  string,
  { toolName: string; toolInput: unknown; startedAt: number }
>();

function append(record: ExternalMcpAuditRecord): void {
  appendFileSync(auditFile!, `${JSON.stringify(record)}\n`, 'utf8');
}

function idKey(id: unknown): string | undefined {
  return typeof id === 'string' || typeof id === 'number'
    ? `${typeof id}:${String(id)}`
    : undefined;
}

function observeRequest(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const message = value as {
    id?: unknown;
    method?: unknown;
    params?: { name?: unknown; arguments?: unknown };
  };
  if (
    message.method !== 'tools/call' ||
    typeof message.params?.name !== 'string'
  ) {
    return;
  }
  const key = idKey(message.id);
  if (!key) return;
  const toolCallId = String(message.id);
  const toolName = message.params.name;
  const toolInput = message.params.arguments;
  pending.set(key, { toolName, toolInput, startedAt: Date.now() });
  append({
    toolCallId,
    serverName: serverName!,
    toolName,
    requestedToolRule: `mcp__${serverName}__${toolName}`,
    resultClass: 'attempt',
    latencyMs: 0,
    argumentSummary: summarizeMcpToolArgumentPayload(toolInput),
    inputHash: hashMcpAuditValue(toolInput),
  });
}

function observeResponse(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const message = value as {
    id?: unknown;
    result?: unknown;
    error?: unknown;
  };
  const key = idKey(message.id);
  if (!key) return;
  const call = pending.get(key);
  if (!call) return;
  pending.delete(key);
  const failed =
    message.error !== undefined ||
    (message.result &&
      typeof message.result === 'object' &&
      (message.result as { isError?: unknown }).isError === true);
  append({
    toolCallId: String(message.id),
    serverName: serverName!,
    toolName: call.toolName,
    requestedToolRule: `mcp__${serverName}__${call.toolName}`,
    resultClass: failed ? 'failure' : 'success',
    latencyMs: Math.max(0, Date.now() - call.startedAt),
    argumentSummary: summarizeMcpToolArgumentPayload(call.toolInput),
    inputHash: hashMcpAuditValue(call.toolInput),
    resultHash: hashMcpAuditValue(message.result ?? message.error),
    ...(failed
      ? { error: { message: 'MCP tool call failed.' } }
      : { evidenceProjection: projectMcpEvidence(message.result) }),
  });
}

const observeInput = createJsonRpcFrameObserver(observeRequest);
const observeOutput = createJsonRpcFrameObserver(observeResponse);
process.stdin.on('data', (chunk: Buffer) => observeInput(chunk));
process.stdin.pipe(child.stdin);
child.stdout.on('data', (chunk: Buffer) => {
  observeOutput(chunk);
  process.stdout.write(chunk);
});
child.stderr.pipe(process.stderr);
child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
