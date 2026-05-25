import { createHash } from 'node:crypto';

import {
  SDK_SANDBOX_NETWORK_ACCESS_TOOL_NAME,
  isSdkSandboxNetworkAccessToolName,
} from '../../../../shared/agent-tool-references.js';
import {
  bashExecutableName,
  parseBashCommand,
} from '../../../../shared/bash-command-parser.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import { sandboxBlockedRuntimeEvents } from './sandbox-events.js';
import type { AgentRunnerInput } from './types.js';

export interface SdkSandboxNetworkGate {
  rememberGlobalApproval(principal: string, expiresAtMs: number): void;
  rememberAllowedTool(
    toolName: string,
    input: Record<string, unknown>,
    permissionOpts: { toolUseID?: string },
    principal?: string,
  ): void;
  decide(
    toolName: string,
    input: Record<string, unknown>,
    permissionOpts: { toolUseID?: string; parentToolUseID?: string },
    principal?: string,
  ):
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string; interrupt: false }
    | null;
}

interface SdkSandboxNetworkGlobalApproval {
  createdAtMs: number;
  expiresAtMs: number;
}

interface SdkSandboxNetworkApprovalToken {
  principal: string;
  parentToolUseID: string;
  approvedToolName: string;
  inputHash: string;
  approvedHostHashes: readonly string[];
  createdAtMs: number;
  expiresAtMs: number;
  parentlessAssociatedAtMs?: number;
}

export interface SdkSandboxNetworkGateOptions {
  ttlMs?: number;
  parentlessAssociationTtlMs?: number;
  nowMs?: () => number;
}

const DEFAULT_SANDBOX_NETWORK_TOKEN_TTL_MS = 300_000;
const DEFAULT_PARENTLESS_SANDBOX_NETWORK_ASSOCIATION_TTL_MS = 30_000;
const LOCAL_ONLY_SDK_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'LS',
  'Glob',
  'Grep',
  'TodoWrite',
]);
const NETWORK_CLIENTS_WITH_URL_TARGETS = new Set(['curl', 'wget']);

export function createSdkSandboxNetworkGate(
  agentInput: AgentRunnerInput,
  options: SdkSandboxNetworkGateOptions = {},
): SdkSandboxNetworkGate {
  const ttlMs = options.ttlMs ?? DEFAULT_SANDBOX_NETWORK_TOKEN_TTL_MS;
  const parentlessAssociationTtlMs =
    options.parentlessAssociationTtlMs ??
    DEFAULT_PARENTLESS_SANDBOX_NETWORK_ASSOCIATION_TTL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const tokens: SdkSandboxNetworkApprovalToken[] = [];
  const latestNetworkToolTokenByPrincipal = new Map<
    string,
    SdkSandboxNetworkApprovalToken
  >();
  const globalApprovals = new Map<string, SdkSandboxNetworkGlobalApproval>();

  function writeEvent(input: {
    decision: string;
    reason: string;
    networkToolUseID?: string;
    parentToolUseID?: string;
    approvedToolName?: string;
    hostHash?: string;
    approvedHostHashes?: readonly string[];
    inputHash?: string;
    tokenCreatedAtMs?: number;
    tokenExpiresAtMs?: number;
    tokenTtlMs?: number;
    expiredTokenCount?: number;
  }): void {
    const payload: Record<string, unknown> = {
      toolName: SDK_SANDBOX_NETWORK_ACCESS_TOOL_NAME,
      canonicalCapability: SDK_SANDBOX_NETWORK_ACCESS_TOOL_NAME,
      decision: input.decision,
      reason: input.reason,
      tokenTtlMs: input.tokenTtlMs ?? ttlMs,
      ...(input.networkToolUseID
        ? { networkToolUseIDHash: hashString(input.networkToolUseID) }
        : {}),
      ...(input.parentToolUseID
        ? { parentToolUseIDHash: hashString(input.parentToolUseID) }
        : {}),
      ...(input.approvedToolName
        ? { approvedToolName: input.approvedToolName }
        : {}),
      ...(input.hostHash ? { hostHash: input.hostHash } : {}),
      ...(input.approvedHostHashes?.length
        ? { approvedHostHashes: input.approvedHostHashes }
        : {}),
      ...(input.inputHash ? { inputHash: input.inputHash } : {}),
      ...(input.tokenCreatedAtMs !== undefined
        ? { tokenCreatedAtMs: input.tokenCreatedAtMs }
        : {}),
      ...(input.tokenExpiresAtMs !== undefined
        ? { tokenExpiresAtMs: input.tokenExpiresAtMs }
        : {}),
      ...(input.expiredTokenCount !== undefined
        ? { expiredTokenCount: input.expiredTokenCount }
        : {}),
    };
    log(`Sandbox network decision ${JSON.stringify(payload)}`);
    writeOutput({
      status: 'success',
      result: null,
      runtimeEvents: sandboxBlockedRuntimeEvents(agentInput, payload),
    });
  }

  function pruneExpiredTokens(now: number): number {
    let expired = 0;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const token = tokens[index];
      if (!token) {
        tokens.splice(index, 1);
        continue;
      }
      if (token.expiresAtMs <= now) {
        tokens.splice(index, 1);
        expired += 1;
        const latest = latestNetworkToolTokenByPrincipal.get(token.principal);
        if (latest === token) {
          latestNetworkToolTokenByPrincipal.delete(token.principal);
        }
      }
    }
    return expired;
  }

  return {
    rememberGlobalApproval(principal, expiresAtMs) {
      const now = nowMs();
      const normalizedPrincipal = principal.trim();
      if (!normalizedPrincipal || expiresAtMs <= now) return;
      globalApprovals.set(normalizedPrincipal, {
        createdAtMs: now,
        expiresAtMs,
      });
      writeEvent({
        decision: 'sdk_network_gate_global_approval_activated',
        reason:
          'Gantry activated a short-lived eligible-tools/SDK-API-prompt approval; SDK sandbox network prompts will be suppressed until it expires.',
        tokenCreatedAtMs: now,
        tokenExpiresAtMs: expiresAtMs,
        tokenTtlMs: expiresAtMs - now,
      });
    },
    rememberAllowedTool(
      toolName,
      input,
      permissionOpts,
      principal = agentInput.agentId ?? 'runner',
    ) {
      if (isSdkSandboxNetworkAccessToolName(toolName)) return;
      if (LOCAL_ONLY_SDK_TOOLS.has(toolName)) return;
      const normalizedPrincipal = principal.trim();
      const parentToolUseID = permissionOpts.toolUseID?.trim();
      if (!normalizedPrincipal || !parentToolUseID) {
        writeEvent({
          decision: 'sdk_network_gate_token_rejected',
          reason:
            'Gantry did not mint a sandbox network token because principal or tool-use id was missing.',
        });
        return;
      }
      const createdAtMs = nowMs();
      const inputHash = hashString(stableJson(input));
      const approvedHostHashes = approvedToolInputHostHashes(toolName, input);
      const token: SdkSandboxNetworkApprovalToken = {
        principal: normalizedPrincipal,
        parentToolUseID,
        approvedToolName: toolName,
        inputHash,
        approvedHostHashes,
        createdAtMs,
        expiresAtMs: createdAtMs + ttlMs,
      };
      tokens.push(token);
      if (toolName === 'Bash') {
        latestNetworkToolTokenByPrincipal.set(normalizedPrincipal, token);
      } else {
        latestNetworkToolTokenByPrincipal.delete(normalizedPrincipal);
      }
      writeEvent({
        decision: 'sdk_network_gate_token_minted',
        reason:
          'Gantry minted a short-lived sandbox network token for an approved tool invocation.',
        parentToolUseID,
        approvedToolName: toolName,
        inputHash,
        approvedHostHashes,
        tokenCreatedAtMs: token.createdAtMs,
        tokenExpiresAtMs: token.expiresAtMs,
      });
    },
    decide(
      toolName,
      input,
      permissionOpts,
      principal = agentInput.agentId ?? 'runner',
    ) {
      if (!isSdkSandboxNetworkAccessToolName(toolName)) return null;

      const hostHash = sandboxNetworkHostHash(input);
      const now = nowMs();
      const expiredTokenCount = pruneExpiredTokens(now);
      const globalApproval = globalApprovals.get(principal);
      if (globalApproval) {
        if (globalApproval.expiresAtMs > now) {
          writeEvent({
            decision: 'sdk_network_gate_global_approval_suppressed',
            reason:
              'SDK requested network approval during an active eligible-tools/SDK-API-prompt approval; suppressing duplicate user approval.',
            networkToolUseID: permissionOpts.toolUseID,
            hostHash,
            tokenCreatedAtMs: globalApproval.createdAtMs,
            tokenExpiresAtMs: globalApproval.expiresAtMs,
            tokenTtlMs: globalApproval.expiresAtMs - globalApproval.createdAtMs,
            expiredTokenCount,
          });
          return { behavior: 'allow', updatedInput: input };
        }
        globalApprovals.delete(principal);
      }
      const parentToolUseID =
        permissionOpts.parentToolUseID?.trim() ??
        sandboxNetworkParentToolUseID(input);
      const activeTokens = tokens.filter(
        (candidate) => candidate.principal === principal,
      );
      const token = parentToolUseID
        ? activeTokens.find(
            (candidate) => candidate.parentToolUseID === parentToolUseID,
          )
        : undefined;
      if (token) {
        writeEvent({
          decision: 'sdk_network_gate_suppressed',
          reason:
            'SDK requested network approval for a recently approved tool invocation; suppressing duplicate user approval.',
          networkToolUseID: permissionOpts.toolUseID,
          parentToolUseID: token.parentToolUseID,
          approvedToolName: token.approvedToolName,
          hostHash,
          inputHash: token.inputHash,
          tokenCreatedAtMs: token.createdAtMs,
          tokenExpiresAtMs: token.expiresAtMs,
          expiredTokenCount,
        });
        return { behavior: 'allow', updatedInput: input };
      }
      if (!parentToolUseID && agentInput.isScheduledJob) {
        const latestToken = latestNetworkToolTokenByPrincipal.get(principal);
        const networkToolUseID = permissionOpts.toolUseID?.trim();
        if (
          latestToken &&
          !latestToken.parentlessAssociatedAtMs &&
          latestToken.approvedToolName === 'Bash' &&
          networkToolUseID &&
          hostHash &&
          latestToken.approvedHostHashes.includes(hostHash) &&
          latestToken.expiresAtMs > now &&
          now - latestToken.createdAtMs <= parentlessAssociationTtlMs
        ) {
          latestToken.parentlessAssociatedAtMs = now;
          latestNetworkToolTokenByPrincipal.delete(principal);
          writeEvent({
            decision: 'sdk_network_gate_suppressed_parentless_recent_tool',
            reason:
              'SDK requested network approval without a parent tool-use id immediately after a recently approved scheduled command for the same host; associating it with the latest run-local tool approval.',
            networkToolUseID,
            parentToolUseID: latestToken.parentToolUseID,
            approvedToolName: latestToken.approvedToolName,
            hostHash,
            approvedHostHashes: latestToken.approvedHostHashes,
            inputHash: latestToken.inputHash,
            tokenCreatedAtMs: latestToken.createdAtMs,
            tokenExpiresAtMs: latestToken.expiresAtMs,
            expiredTokenCount,
          });
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const reason = parentToolUseID
        ? 'SDK requested sandbox network access for a tool-use id Gantry did not approve.'
        : 'SDK requested sandbox network access without a parent tool-use id.';
      writeEvent({
        decision: 'sdk_network_gate_denied',
        reason,
        networkToolUseID: permissionOpts.toolUseID,
        ...(parentToolUseID ? { parentToolUseID } : {}),
        hostHash,
        expiredTokenCount,
      });
      return {
        behavior: 'deny',
        message: `${reason} Approve the tool call through Gantry first.`,
        interrupt: false,
      };
    },
  };
}

function sandboxNetworkHostHash(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const host = (input as Record<string, unknown>).host;
  if (typeof host !== 'string' || !host.trim()) return undefined;
  const normalized = normalizeNetworkHost(host);
  return normalized ? hashString(normalized) : undefined;
}

function sandboxNetworkParentToolUseID(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const value =
    record.parentToolUseID ??
    record.parent_tool_use_id ??
    record.toolUseID ??
    record.tool_use_id;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function approvedToolInputHostHashes(
  toolName: string,
  input: unknown,
): readonly string[] {
  const hosts = new Set<string>();
  if (toolName === 'Bash') {
    collectApprovedBashTargetHosts(input, hosts);
  }
  return [...hosts].sort().map(hashString);
}

function collectApprovedBashTargetHosts(
  input: unknown,
  hosts: Set<string>,
): void {
  if (!input || typeof input !== 'object') return;
  const record = input as Record<string, unknown>;
  const command =
    typeof record.command === 'string'
      ? record.command
      : typeof record.cmd === 'string'
        ? record.cmd
        : '';
  if (!command.trim()) return;
  const parsed = parseBashCommand(command);
  if (!parsed.ok) return;
  for (const leaf of parsed.leaves) {
    const executable = bashExecutableName(leaf.argv[0] ?? '');
    if (!NETWORK_CLIENTS_WITH_URL_TARGETS.has(executable)) continue;
    for (const host of networkHostsFromNetworkClientArgv(leaf.argv)) {
      hosts.add(host);
    }
  }
}

function networkHostsFromNetworkClientArgv(argv: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--url') {
      const host = hostFromHttpUrl(argv[index + 1] ?? '');
      if (host) hosts.add(host);
      index += 1;
      continue;
    }
    if (arg.startsWith('--url=')) {
      const host = hostFromHttpUrl(arg.slice('--url='.length));
      if (host) hosts.add(host);
      continue;
    }
    const host = hostFromHttpUrl(arg);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

function hostFromHttpUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  try {
    return normalizeNetworkHost(new URL(trimmed).hostname);
  } catch {
    return undefined;
  }
}

function normalizeNetworkHost(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(
      trimmed.includes('://') ? trimmed : `http://${trimmed}`,
    );
    const host = parsed.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.+$/, '');
    return host || undefined;
  } catch {
    return undefined;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = stableValue(record[key]);
    }
    return out;
  }
  return value;
}
