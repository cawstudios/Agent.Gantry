import {
  agentIdForFolder,
  folderForAgentId,
} from '../../domain/agent/agent-folder-id.js';
import type { Agent } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentRepository } from '../../domain/ports/repositories.js';
import {
  CALLABLE_AGENT_SYNC_WAIT_TIMEOUT_MS,
  CALLABLE_AGENT_TOOL_PREFIX,
  callableAgentToolName,
  type CallableAgentToolInputSchema,
  type CallableAgentToolManifestEntry,
} from '../../shared/callable-agent-manifest.js';
import { sha256Base64Url } from '../../shared/stable-hash.js';
import type {
  CoreTaskLifecycleBackend,
  CoreTaskLifecycleErrorCode,
  CoreTaskLifecycleResult,
} from './task-lifecycle.js';
import { coreTaskLifecycleResultText } from './task-lifecycle.js';
import { sendCoreMessage, type CoreSendMessageDeps } from './send-message.js';

const CALLABLE_AGENT_NARRATION_TIMEOUT_MS = 5_000;

export {
  CALLABLE_AGENT_RESPONSE_TIMEOUT_MS,
  CALLABLE_AGENT_SYNC_WAIT_MAX_MS,
  CALLABLE_AGENT_SYNC_WAIT_TIMEOUT_MS,
  CALLABLE_AGENT_TOOL_PREFIX,
  callableAgentToolName,
  createCallableAgentToolSchema,
  parseCallableAgentManifest,
  type CallableAgentToolInput,
  type CallableAgentToolInputSchema,
  type CallableAgentToolManifestEntry,
} from '../../shared/callable-agent-manifest.js';

export function isCallableAgentToolName(name: string): boolean {
  return name.startsWith(CALLABLE_AGENT_TOOL_PREFIX);
}

export function createCallableAgentToolDefinitions(input: {
  manifest: readonly CallableAgentToolManifestEntry[];
  schema: CallableAgentToolInputSchema;
  dispatch(
    entry: CallableAgentToolManifestEntry,
    args: Record<string, unknown>,
  ): Promise<CoreTaskLifecycleResult>;
}) {
  return input.manifest.map((entry) => ({
    name: callableAgentToolName(entry),
    description: `Delegate to ${entry.displayName}.`,
    inputSchema: input.schema,
    handler: async (args: Record<string, unknown>) =>
      coreTaskLifecycleMcpResult(await input.dispatch(entry, args)),
  }));
}

export function coreTaskLifecycleMcpResult(result: CoreTaskLifecycleResult) {
  const text = coreTaskLifecycleResultText(result);
  return {
    content: [{ type: 'text' as const, text }],
    ...(result.ok
      ? {}
      : { isError: true, error: taskLifecycleError(result.code, text) }),
  };
}

function taskLifecycleError(
  code: CoreTaskLifecycleErrorCode | undefined,
  message: string,
) {
  switch (code) {
    case 'unavailable':
      return { category: 'transient' as const, isRetryable: true, message };
    case 'invalid_request':
      return { category: 'validation' as const, isRetryable: false, message };
    case 'forbidden':
      return { category: 'permission' as const, isRetryable: false, message };
    case 'not_found':
    default:
      return { category: 'business' as const, isRetryable: false, message };
  }
}

export function projectCallableAgentTools(input: {
  agents: readonly Agent[];
  callerAppId: string;
  callerAgentId: string;
  callerFolder: string;
  delegates: readonly string[];
  toolPolicyRules?: readonly string[];
  parentTaskId?: string | null;
}): CallableAgentToolManifestEntry[] {
  if (
    input.parentTaskId != null ||
    !input.toolPolicyRules?.includes('AgentDelegation') ||
    input.delegates.length === 0
  ) {
    return [];
  }
  const callerIds = new Set([
    input.callerAgentId,
    String(agentIdForFolder(input.callerFolder)),
  ]);
  const byIdentity = new Map<string, Agent>();
  for (const agent of input.agents) {
    if (
      String(agent.appId) !== input.callerAppId ||
      agent.status !== 'active' ||
      callerIds.has(String(agent.id))
    ) {
      continue;
    }
    byIdentity.set(String(agent.id), agent);
    const folder = folderForAgentId(agent.id);
    if (folder) byIdentity.set(folder, agent);
  }
  const seen = new Set<string>();
  return input.delegates.flatMap((delegate) => {
    const agent =
      byIdentity.get(delegate) ??
      byIdentity.get(String(agentIdForFolder(delegate)));
    if (!agent || seen.has(String(agent.id))) return [];
    seen.add(String(agent.id));
    const displayName = (
      agent.name.replace(/\s+/g, ' ').trim() ||
      folderForAgentId(agent.id) ||
      String(agent.id)
    ).slice(0, 200);
    return [
      {
        toolName: immutableToolName(String(agent.id)),
        targetAgentId: String(agent.id),
        displayName,
      },
    ];
  });
}

export async function preloadCallableAgentManifest(input: {
  run: {
    appId?: string;
    agentId?: string;
    parentTaskId?: string | null;
    toolPolicyRules?: readonly string[];
  };
  delegates: readonly string[];
  callerFolder: string;
  toolsAvailable: boolean;
  getRepository?: () => AgentRepository;
}) {
  const { run } = input;
  if (
    !input.toolsAvailable ||
    run.parentTaskId != null ||
    !run.toolPolicyRules?.includes('AgentDelegation') ||
    !run.appId ||
    !run.agentId ||
    input.delegates.length === 0 ||
    !input.getRepository
  ) {
    return [];
  }
  return projectCallableAgentTools({
    agents: await input.getRepository().listAgents(run.appId as AppId),
    callerAppId: run.appId,
    callerAgentId: run.agentId,
    callerFolder: input.callerFolder,
    delegates: input.delegates,
    toolPolicyRules: run.toolPolicyRules,
    parentTaskId: run.parentTaskId,
  });
}

export async function dispatchCallableAgentTool(input: {
  args: Record<string, unknown>;
  entry: CallableAgentToolManifestEntry;
  backend: CoreTaskLifecycleBackend;
  revalidate(entry: CallableAgentToolManifestEntry): Promise<boolean>;
  narration?: {
    sourceAgentFolder: string;
    isScheduledJob?: boolean;
    deps: CoreSendMessageDeps & {
      warn(context: Record<string, unknown>, message: string): void;
    };
  };
}): Promise<CoreTaskLifecycleResult> {
  if (Object.prototype.hasOwnProperty.call(input.args, 'targetAgentId')) {
    return {
      ok: false,
      message: 'Callable agent tools do not accept targetAgentId.',
      code: 'invalid_request',
    };
  }
  if (!(await input.revalidate(input.entry))) {
    return {
      ok: false,
      message: 'Callable agent target is no longer permitted.',
      code: 'forbidden',
    };
  }
  await narrate(input, `Checking with the ${input.entry.displayName} agent…`);
  if (!(await input.revalidate(input.entry))) {
    void narrate(input, `${input.entry.displayName} is no longer available.`);
    return {
      ok: false,
      message: 'Callable agent target is no longer permitted.',
      code: 'forbidden',
    };
  }
  const result = await input.backend.delegate_task({
    ...input.args,
    targetAgentId: input.entry.targetAgentId,
    syncWaitTimeoutMs:
      typeof input.args.syncWaitTimeoutMs === 'number'
        ? input.args.syncWaitTimeoutMs
        : CALLABLE_AGENT_SYNC_WAIT_TIMEOUT_MS,
  });
  const status =
    typeof result.data === 'object' && result.data !== null
      ? (result.data as { status?: unknown }).status
      : undefined;
  if (result.ok && status === 'completed') {
    void narrate(input, `${input.entry.displayName} responded.`);
  } else if (result.ok && (status === 'queued' || status === 'running')) {
    void narrate(
      input,
      `${input.entry.displayName} is still working; I'll follow up.`,
    );
  } else if (!result.ok) {
    void narrate(input, `Delegation to ${input.entry.displayName} failed.`);
  }
  return result;
}

async function narrate(
  input: Parameters<typeof dispatchCallableAgentTool>[0],
  text: string,
): Promise<void> {
  const owner = input.backend.owner;
  if (!input.narration || !owner) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sendCoreMessage({
        message: { text },
        context: {
          appId: owner.appId,
          sourceAgentFolder: input.narration.sourceAgentFolder,
          targetJid: owner.conversationId,
          providerAccountId: owner.providerAccountId ?? undefined,
          threadId: owner.threadId ?? undefined,
          isScheduledJob: input.narration.isScheduledJob,
        },
        deps: input.narration.deps,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Narration delivery timed out.')),
          CALLABLE_AGENT_NARRATION_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
  } catch (error) {
    input.narration.deps.warn(
      {
        toolName: `${CALLABLE_AGENT_TOOL_PREFIX}${input.entry.toolName}`,
        error: error instanceof Error ? error.message : String(error),
      },
      'Callable-agent narration delivery failed',
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function immutableToolName(agentId: string): string {
  const identity = folderForAgentId(agentId as Agent['id']) ?? agentId;
  const stem =
    identity
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 8) || 'agent';
  // Leaves room for the fully qualified facade name within the shared 64-char cap.
  const digest = sha256Base64Url(agentId).slice(0, 30);
  return `${stem}_${digest}`;
}
