export type ControlPlaneRuntimeStatus = 'Ready' | 'Needs setup' | 'Blocked';
export type ControlPlaneMemoryStatus =
  | 'Ready'
  | 'Needs setup'
  | 'Needs review'
  | 'Disabled';

export interface ControlPlaneProviderInput {
  id: string;
  label: string;
  ready: boolean;
  blocked?: boolean;
}

export interface ControlPlaneConversationInput {
  id: string;
  agentId?: string;
  ready: boolean;
}

export interface ControlPlaneAgentInput {
  id: string;
  name: string;
  modelAlias: string;
  approvedCapabilities: number;
}

export interface ControlPlaneJobInput {
  id: string;
  agentId?: string;
  status: 'ready' | 'needs_action' | 'blocked';
}

export interface ControlPlaneReadModelInput {
  workspaceKey: string;
  runtimeBlocked?: boolean;
  modelCredentialReady: boolean;
  providers: ControlPlaneProviderInput[];
  conversations: ControlPlaneConversationInput[];
  agents: ControlPlaneAgentInput[];
  jobs: ControlPlaneJobInput[];
  approvedAccessCount: number;
  accessNeedsApprovalCount: number;
  memoryStatus: ControlPlaneMemoryStatus;
}

export interface ControlPlaneSettingsView {
  agent: { defaultModel: string };
  agents: Record<
    string,
    {
      name: string;
      model?: string;
      capabilities: Array<{ id: string; version: string }>;
    }
  >;
  conversations: Record<string, unknown>;
  bindings: Record<string, { agent: string; conversation: string }>;
}

export interface ControlPlaneSettingsReadModelInput {
  settings: ControlPlaneSettingsView;
  workspaceKey: string;
  runtimeBlocked?: boolean;
  modelCredentialReady: boolean;
  providers: ControlPlaneProviderInput[];
  memoryStatus: ControlPlaneMemoryStatus;
  jobs?: ControlPlaneJobInput[];
  accessNeedsApprovalCount?: number;
}

export type ControlPlaneNextAction =
  | { kind: 'runtime_blocked'; label: string }
  | { kind: 'missing_model_credential'; label: string }
  | { kind: 'missing_provider_connection'; label: string }
  | { kind: 'missing_conversation_binding'; label: string }
  | { kind: 'missing_access_approval'; label: string }
  | { kind: 'blocked_job'; label: string }
  | { kind: 'memory_review_setup'; label: string }
  | { kind: 'none'; label: 'none' };

export interface ControlPlaneReadModel {
  title: 'Gantry';
  runtime: ControlPlaneRuntimeStatus;
  workspaceKey: string;
  agents: { ready: number; total: number };
  conversations: { ready: number; total: number };
  jobs: { ready: number; needsAction: number; blocked: number };
  access: { approved: number; needsApproval: number };
  memory: ControlPlaneMemoryStatus;
  providers: { ready: number; needsConnection: number; blocked: number };
  nextAction: ControlPlaneNextAction;
  agentDetails: ControlPlaneAgentDetail[];
}

export interface ControlPlaneAgentDetail {
  id: string;
  name: string;
  modelAlias: string;
  workspaceKey: string;
  conversations: number;
  approvedCapabilities: number;
  activeJobs: number;
  memory: ControlPlaneMemoryStatus;
  nextAction: ControlPlaneNextAction;
}

export function buildControlPlaneReadModel(
  input: ControlPlaneReadModelInput,
): ControlPlaneReadModel {
  const providerCounts = input.providers.reduce(
    (counts, provider) => {
      if (provider.blocked) counts.blocked += 1;
      else if (provider.ready) counts.ready += 1;
      else counts.needsConnection += 1;
      return counts;
    },
    { ready: 0, needsConnection: 0, blocked: 0 },
  );
  const conversationsReady = input.conversations.filter(
    (conversation) => conversation.ready,
  ).length;
  const jobCounts = input.jobs.reduce(
    (counts, job) => {
      if (job.status === 'blocked') counts.blocked += 1;
      else if (job.status === 'needs_action') counts.needsAction += 1;
      else counts.ready += 1;
      return counts;
    },
    { ready: 0, needsAction: 0, blocked: 0 },
  );
  const nextAction = selectControlPlaneNextAction({
    runtimeBlocked: input.runtimeBlocked === true,
    modelCredentialReady: input.modelCredentialReady,
    providerCounts,
    conversationsReady,
    conversationsTotal: input.conversations.length,
    accessNeedsApprovalCount: input.accessNeedsApprovalCount,
    blockedJobs: jobCounts.blocked,
    memoryStatus: input.memoryStatus,
  });
  const agentDetails = input.agents.map((agent) => {
    const agentConversations = input.conversations.filter(
      (conversation) => conversation.agentId === agent.id && conversation.ready,
    ).length;
    const activeJobs = input.jobs.filter(
      (job) => job.agentId === agent.id && job.status !== 'blocked',
    ).length;
    return {
      id: agent.id,
      name: agent.name,
      modelAlias: agent.modelAlias,
      workspaceKey: input.workspaceKey,
      conversations: agentConversations,
      approvedCapabilities: agent.approvedCapabilities,
      activeJobs,
      memory: input.memoryStatus,
      nextAction: selectControlPlaneNextAction({
        runtimeBlocked: input.runtimeBlocked === true,
        modelCredentialReady: input.modelCredentialReady,
        providerCounts,
        conversationsReady: agentConversations,
        conversationsTotal: agentConversations,
        accessNeedsApprovalCount: 0,
        blockedJobs: input.jobs.filter(
          (job) => job.agentId === agent.id && job.status === 'blocked',
        ).length,
        memoryStatus: input.memoryStatus,
      }),
    };
  });

  return {
    title: 'Gantry',
    runtime: runtimeStatus(nextAction),
    workspaceKey: input.workspaceKey,
    agents: {
      ready: input.agents.filter(
        (agent) => input.modelCredentialReady && Boolean(agent.modelAlias),
      ).length,
      total: input.agents.length,
    },
    conversations: {
      ready: conversationsReady,
      total: input.conversations.length,
    },
    jobs: jobCounts,
    access: {
      approved: input.approvedAccessCount,
      needsApproval: input.accessNeedsApprovalCount,
    },
    memory: input.memoryStatus,
    providers: providerCounts,
    nextAction,
    agentDetails,
  };
}

export function buildControlPlaneReadModelFromSettings(
  input: ControlPlaneSettingsReadModelInput,
): ControlPlaneReadModel {
  const conversations = Object.keys(input.settings.conversations).map((id) => {
    const binding = Object.values(input.settings.bindings).find(
      (candidate) => candidate.conversation === id,
    );
    return {
      id,
      ...(binding?.agent ? { agentId: binding.agent } : {}),
      ready: Boolean(binding && input.settings.agents[binding.agent]),
    };
  });
  const agents = Object.entries(input.settings.agents).map(([id, agent]) => ({
    id,
    name: agent.name,
    modelAlias: agent.model || input.settings.agent.defaultModel,
    approvedCapabilities: agent.capabilities.length,
  }));
  const approvedAccessCount = agents.reduce(
    (total, agent) => total + agent.approvedCapabilities,
    0,
  );
  return buildControlPlaneReadModel({
    workspaceKey: input.workspaceKey,
    runtimeBlocked: input.runtimeBlocked,
    modelCredentialReady: input.modelCredentialReady,
    providers: input.providers,
    conversations,
    agents,
    jobs: input.jobs ?? [],
    approvedAccessCount,
    accessNeedsApprovalCount: input.accessNeedsApprovalCount ?? 0,
    memoryStatus: input.memoryStatus,
  });
}

export function selectControlPlaneNextAction(input: {
  runtimeBlocked: boolean;
  modelCredentialReady: boolean;
  providerCounts: { ready: number; needsConnection: number; blocked: number };
  conversationsReady: number;
  conversationsTotal: number;
  accessNeedsApprovalCount: number;
  blockedJobs: number;
  memoryStatus: ControlPlaneMemoryStatus;
}): ControlPlaneNextAction {
  if (input.runtimeBlocked) {
    return {
      kind: 'runtime_blocked',
      label: 'Run gantry doctor and fix blocking runtime checks.',
    };
  }
  if (!input.modelCredentialReady) {
    return {
      kind: 'missing_model_credential',
      label: 'Connect Model Access credentials.',
    };
  }
  if (input.providerCounts.blocked > 0) {
    return {
      kind: 'missing_provider_connection',
      label: 'Fix the blocked provider connection.',
    };
  }
  if (
    input.providerCounts.ready === 0 ||
    input.providerCounts.needsConnection > 0
  ) {
    return {
      kind: 'missing_provider_connection',
      label: 'Connect a provider.',
    };
  }
  if (input.conversationsTotal === 0 || input.conversationsReady === 0) {
    return {
      kind: 'missing_conversation_binding',
      label: 'Bind an agent to a conversation.',
    };
  }
  if (input.accessNeedsApprovalCount > 0) {
    return {
      kind: 'missing_access_approval',
      label: 'Approve pending access requests.',
    };
  }
  if (input.blockedJobs > 0) {
    return {
      kind: 'blocked_job',
      label: 'Review blocked jobs.',
    };
  }
  if (input.memoryStatus === 'Needs review') {
    return {
      kind: 'memory_review_setup',
      label: 'Review pending memory items.',
    };
  }
  if (input.memoryStatus === 'Needs setup') {
    return {
      kind: 'memory_review_setup',
      label: 'Finish memory setup.',
    };
  }
  return { kind: 'none', label: 'none' };
}

export function formatControlPlaneStatus(model: ControlPlaneReadModel): string {
  return [
    model.title,
    '',
    `Runtime: ${model.runtime}`,
    `Workspace: ${model.workspaceKey}`,
    `Agents: ${model.agents.ready}/${model.agents.total}`,
    `Conversations: ${model.conversations.ready}/${model.conversations.total}`,
    `Jobs: ${model.jobs.ready}/${model.jobs.needsAction}/${model.jobs.blocked}`,
    `Access: ${model.access.approved}/${model.access.needsApproval}`,
    `Memory: ${model.memory}`,
    `Providers: ${model.providers.ready}/${model.providers.needsConnection}/${model.providers.blocked}`,
    '',
    `Next action: ${model.nextAction.label}`,
  ].join('\n');
}

export function formatControlPlaneAgentDetail(
  detail: ControlPlaneAgentDetail,
): string {
  return [
    `Agent: ${detail.name}`,
    `Model: ${detail.modelAlias}`,
    `Workspace: ${detail.workspaceKey}`,
    `Conversations: ${detail.conversations}`,
    `Access: ${detail.approvedCapabilities}`,
    `Jobs: ${detail.activeJobs}`,
    `Memory: ${detail.memory}`,
    `Next action: ${detail.nextAction.label}`,
  ].join('\n');
}

function runtimeStatus(
  nextAction: ControlPlaneNextAction,
): ControlPlaneRuntimeStatus {
  if (nextAction.kind === 'runtime_blocked') return 'Blocked';
  if (nextAction.kind === 'blocked_job') return 'Blocked';
  if (nextAction.kind === 'none') return 'Ready';
  return 'Needs setup';
}
