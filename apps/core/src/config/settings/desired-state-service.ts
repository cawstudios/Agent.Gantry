import { createHash } from 'node:crypto';

import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentMcpServerBinding } from '../../domain/mcp/mcp-servers.js';
import type {
  AgentRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { AgentSkillBinding } from '../../domain/skills/skills.js';
import type { AgentToolBinding } from '../../domain/tools/tools.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeConfiguredAgentCapabilities,
  RuntimeSettings,
} from './runtime-settings-types.js';

interface StoredAgentBinding {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
  agentConfig?: { model?: string };
}

export interface SettingsDesiredStateOps {
  getAllRegisteredGroups(): Promise<Record<string, StoredAgentBinding>>;
  setRegisteredGroup(jid: string, group: StoredAgentBinding): Promise<void>;
  deleteRegisteredGroup?(jid: string): Promise<void>;
}

export interface SettingsDesiredStateRepositories {
  agents: AgentRepository;
  tools: ToolCatalogRepository;
  skills: SkillCatalogRepository;
  mcpServers: McpServerRepository;
}

export interface SettingsDesiredStateServiceDeps {
  appId?: AppId;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  clock?: { now(): string };
}

export interface SettingsDesiredStateDriftReport {
  missingSettingsAgents: string[];
  dbOnlyGroupJids: string[];
  invalidReferences: string[];
}

export interface SettingsReconcileResult {
  applied: string[];
  skipped: string[];
  invalidReferences: string[];
}

export interface SettingsChangeClassification {
  liveApplied: string[];
  restartRequired: string[];
}

export class SettingsDesiredStateService {
  private readonly appId: AppId;
  private readonly clock: { now(): string };

  constructor(private readonly deps: SettingsDesiredStateServiceDeps) {
    this.appId = deps.appId ?? ('default' as AppId);
    this.clock = deps.clock ?? { now: () => new Date().toISOString() };
  }

  async exportCurrent(settings: RuntimeSettings): Promise<RuntimeSettings> {
    const groups = await this.deps.ops.getAllRegisteredGroups();
    const agents: Record<string, RuntimeConfiguredAgent> = {
      ...settings.agents,
    };

    const exportedGroups = await Promise.all(
      Object.entries(groups).map(async ([jid, group]) => {
        const agentId = agentIdForFolder(group.folder);
        const [
          dmAccess,
          dmApprovers,
          toolBindings,
          skillBindings,
          mcpBindings,
        ] = await Promise.all([
          this.deps.repositories.agents.listAgentDmAccess({
            appId: this.appId,
            agentId,
          }),
          this.deps.repositories.agents.listAgentDmApprovers({
            appId: this.appId,
            agentId,
          }),
          this.deps.repositories.tools.listAgentToolBindings({
            appId: this.appId,
            agentId,
          }),
          this.deps.repositories.skills.listAgentSkillBindings({
            appId: this.appId,
            agentId,
          }),
          this.deps.repositories.mcpServers.listAgentBindings({
            appId: this.appId,
            agentId,
            limit: 500,
          }),
        ]);
        return {
          jid,
          group,
          dmAccess,
          dmApprovers,
          toolBindings,
          skillBindings,
          mcpBindings,
        };
      }),
    );

    for (const exported of exportedGroups) {
      const {
        jid,
        group,
        dmAccess,
        dmApprovers,
        toolBindings,
        skillBindings,
        mcpBindings,
      } = exported;
      const folder = group.folder;
      const existing = agents[folder];
      const bindingId = stableBindingId(jid, existing?.bindings ?? {});
      agents[folder] = {
        name: existing?.name ?? group.name,
        folder,
        model: existing?.model ?? group.agentConfig?.model,
        oneTimeJobDefaultModel: existing?.oneTimeJobDefaultModel,
        recurringJobDefaultModel: existing?.recurringJobDefaultModel,
        bindings: {
          ...(existing?.bindings ?? {}),
          [bindingId]: {
            jid,
            name: group.name,
            trigger: group.trigger,
            addedAt: group.added_at,
            requiresTrigger: group.requiresTrigger !== false,
            isMain: group.isMain === true,
            model: group.agentConfig?.model,
          },
        },
        dmAccess: mergeDmAccess(
          existing?.dmAccess ?? [],
          dmAccess.map((entry) => ({
            provider: entry.providerId,
            externalUserId: entry.externalUserId,
          })),
          dmApprovers.map((entry) => ({
            provider: entry.providerId,
            externalUserId: entry.externalUserId,
          })),
        ),
        capabilities:
          existing?.capabilities ??
          activeCapabilities(toolBindings, skillBindings, mcpBindings),
      };
    }

    return {
      ...settings,
      agents,
    };
  }

  async drift(
    settings: RuntimeSettings,
  ): Promise<SettingsDesiredStateDriftReport> {
    const groups = await this.deps.ops.getAllRegisteredGroups();
    const configuredFolders = new Set(Object.keys(settings.agents));
    const configuredJids = new Set(
      Object.values(settings.agents).flatMap((agent) =>
        Object.values(agent.bindings).map((binding) => binding.jid),
      ),
    );
    return {
      missingSettingsAgents: [
        ...new Set(
          Object.values(groups)
            .map((group) => group.folder)
            .filter((folder) => !configuredFolders.has(folder)),
        ),
      ].sort(),
      dbOnlyGroupJids: Object.keys(groups)
        .filter((jid) => !configuredJids.has(jid))
        .sort(),
      invalidReferences: await this.validateCapabilityReferences(settings),
    };
  }

  async reconcile(settings: RuntimeSettings): Promise<SettingsReconcileResult> {
    const invalidReferences = await this.validateCapabilityReferences(settings);
    if (invalidReferences.length > 0) {
      return { applied: [], skipped: [], invalidReferences };
    }

    const applied: string[] = [];
    const skipped: string[] = [];
    const existingGroups = await this.deps.ops.getAllRegisteredGroups();
    const configuredFolders = new Set(Object.keys(settings.agents));
    const configuredJids = new Set<string>();

    for (const [folder, agent] of Object.entries(settings.agents)) {
      const agentId = agentIdForFolder(folder);
      const now = this.clock.now();
      await this.deps.repositories.agents.saveAgent({
        id: agentId,
        appId: this.appId,
        name: agent.name,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      applied.push(`agent:${folder}`);

      for (const binding of Object.values(agent.bindings)) {
        configuredJids.add(binding.jid);
        await this.deps.ops.setRegisteredGroup(binding.jid, {
          name: binding.name ?? agent.name,
          folder,
          trigger: binding.trigger,
          added_at: binding.addedAt,
          requiresTrigger: binding.requiresTrigger,
          isMain: binding.isMain,
          agentConfig: binding.model ? { model: binding.model } : undefined,
        });
        applied.push(`binding:${binding.jid}`);
      }

      if (settings.desiredState.authoritative || agent.dmAccess.length > 0) {
        await this.deps.repositories.agents.replaceAgentDmAccessPolicy({
          appId: this.appId,
          agentId,
          accessEntries: agent.dmAccess.flatMap((entry) =>
            entry.userIds.map((externalUserId) => ({
              providerId: entry.provider,
              externalUserId,
            })),
          ),
          approverEntries: agent.dmAccess.flatMap((entry) =>
            entry.adminUserId
              ? [
                  {
                    providerId: entry.provider,
                    externalUserId: entry.adminUserId,
                  },
                ]
              : [],
          ),
          updatedAt: now,
        });
        applied.push(`dm_access:${folder}`);
      } else {
        skipped.push(`dm_access:${folder}:not-authoritative-empty`);
      }

      if (
        settings.desiredState.authoritative ||
        hasAnyCapability(agent.capabilities)
      ) {
        await this.replaceCapabilities(agentId, agent.capabilities, now);
        applied.push(`capabilities:${folder}`);
      } else {
        skipped.push(`capabilities:${folder}:not-authoritative-empty`);
      }
    }

    if (
      settings.desiredState.authoritative &&
      this.deps.ops.deleteRegisteredGroup
    ) {
      await Promise.all(
        Object.keys(existingGroups)
          .filter((jid) => !configuredJids.has(jid))
          .map((jid) => this.deps.ops.deleteRegisteredGroup!(jid)),
      );
      applied.push('authoritative:removed_absent_bindings');
    }

    if (settings.desiredState.authoritative) {
      const agents = await this.deps.repositories.agents.listAgents(this.appId);
      for (const agent of agents) {
        const folder = folderForAgentId(agent.id);
        if (!folder || configuredFolders.has(folder)) continue;
        const now = this.clock.now();
        await this.deps.repositories.agents.disableAgent({
          appId: this.appId,
          agentId: agent.id,
          updatedAt: now,
        });
        await this.deps.repositories.agents.replaceAgentDmAccessPolicy({
          appId: this.appId,
          agentId: agent.id,
          accessEntries: [],
          approverEntries: [],
          updatedAt: now,
        });
        await this.replaceCapabilities(
          agent.id,
          { toolIds: [], skillIds: [], mcpServerIds: [] },
          now,
        );
        applied.push(`authoritative:disabled_absent_agent:${folder}`);
      }
    }

    return { applied, skipped, invalidReferences: [] };
  }

  async validateCapabilityReferences(
    settings: RuntimeSettings,
  ): Promise<string[]> {
    const errors: string[] = [];
    const toolIds = new Set<string>();
    const skillIds = new Set<string>();
    const serverIds = new Set<string>();
    for (const agent of Object.values(settings.agents)) {
      for (const toolId of agent.capabilities.toolIds) toolIds.add(toolId);
      for (const skillId of agent.capabilities.skillIds) skillIds.add(skillId);
      for (const serverId of agent.capabilities.mcpServerIds) {
        serverIds.add(serverId);
      }
    }
    const [tools, skills, servers] = await Promise.all([
      this.loadToolsById([...toolIds]),
      this.loadSkillsById([...skillIds]),
      this.loadMcpServersById([...serverIds]),
    ]);
    for (const [folder, agent] of Object.entries(settings.agents)) {
      for (const toolId of [...new Set(agent.capabilities.toolIds)]) {
        const tool = tools.get(toolId);
        if (
          !tool ||
          tool.appId !== this.appId ||
          tool.status !== 'active' ||
          !tool.selectable
        ) {
          errors.push(
            `agents.${folder}.capabilities.tool_ids contains unavailable tool: ${toolId}`,
          );
        }
      }
      for (const skillId of [...new Set(agent.capabilities.skillIds)]) {
        const skill = skills.get(skillId);
        if (
          !skill ||
          skill.appId !== this.appId ||
          skill.status !== 'approved'
        ) {
          errors.push(
            `agents.${folder}.capabilities.skill_ids contains unavailable skill: ${skillId}`,
          );
        } else if (!skill.storage && !skill.providerRef) {
          errors.push(
            `agents.${folder}.capabilities.skill_ids references skill without artifact/provider storage: ${skillId}`,
          );
        }
      }
      for (const serverId of [...new Set(agent.capabilities.mcpServerIds)]) {
        const server = servers.get(serverId);
        if (
          !server ||
          server.appId !== this.appId ||
          server.status !== 'approved' ||
          !server.latestApprovedVersionId
        ) {
          errors.push(
            `agents.${folder}.capabilities.mcp_server_ids contains unavailable MCP server: ${serverId}`,
          );
        }
      }
    }
    return errors.sort();
  }

  private async replaceCapabilities(
    agentId: AgentId,
    capabilities: RuntimeConfiguredAgentCapabilities,
    now: string,
  ): Promise<void> {
    const mcpServersById = await this.getApprovedMcpServersById(
      capabilities.mcpServerIds,
    );
    await this.deps.repositories.agents.replaceAgentCapabilityBindings({
      appId: this.appId,
      agentId,
      toolBindings: capabilities.toolIds.map((toolId) => ({
        id: `agent-tool-binding:${agentId}:${toolId}` as never,
        appId: this.appId,
        agentId,
        toolId: toolId as never,
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
      })),
      skillBindings: capabilities.skillIds.map((skillId) => ({
        id: `agent-skill-binding:${agentId}:${skillId}` as never,
        appId: this.appId,
        agentId,
        skillId: skillId as never,
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
      })),
      mcpBindings: capabilities.mcpServerIds.map((serverId) => {
        const server = mcpServersById.get(serverId);
        return {
          id: `agent-mcp-binding:${agentId}:${serverId}` as never,
          appId: this.appId,
          agentId,
          serverId: serverId as never,
          versionId: server!.latestApprovedVersionId! as never,
          status: 'active' as const,
          required: false,
          permissionPolicyIds: [],
          createdAt: now,
          updatedAt: now,
        };
      }),
      updatedAt: now,
    });
  }

  private async getApprovedMcpServersById(
    serverIds: readonly string[],
  ): Promise<Map<string, { latestApprovedVersionId?: string }>> {
    const servers = await this.loadMcpServersById([...new Set(serverIds)]);
    return new Map(
      [...servers.entries()]
        .filter(([, server]) => server)
        .map(([serverId, server]) => [
          serverId,
          { latestApprovedVersionId: server!.latestApprovedVersionId },
        ]),
    );
  }

  private async loadToolsById(
    toolIds: readonly string[],
  ): Promise<
    Map<string, Awaited<ReturnType<ToolCatalogRepository['getTool']>>>
  > {
    const tools = await Promise.all(
      toolIds.map(
        async (toolId) =>
          [
            toolId,
            await this.deps.repositories.tools.getTool(toolId as never),
          ] as const,
      ),
    );
    return new Map(tools);
  }

  private async loadSkillsById(
    skillIds: readonly string[],
  ): Promise<
    Map<string, Awaited<ReturnType<SkillCatalogRepository['getSkill']>>>
  > {
    const skills = await Promise.all(
      skillIds.map(
        async (skillId) =>
          [
            skillId,
            await this.deps.repositories.skills.getSkill(skillId as never),
          ] as const,
      ),
    );
    return new Map(skills);
  }

  private async loadMcpServersById(
    serverIds: readonly string[],
  ): Promise<
    Map<string, Awaited<ReturnType<McpServerRepository['getServer']>>>
  > {
    const servers = await Promise.all(
      serverIds.map(
        async (serverId) =>
          [
            serverId,
            await this.deps.repositories.mcpServers.getServer(
              serverId as never,
            ),
          ] as const,
      ),
    );
    return new Map(servers);
  }
}

export function classifySettingsChanges(
  before: RuntimeSettings,
  after: RuntimeSettings,
): SettingsChangeClassification {
  const liveApplied: string[] = [];
  const restartRequired: string[] = [];

  if (!jsonEqual(before.storage, after.storage)) {
    restartRequired.push('storage');
  }
  if (!jsonEqual(before.credentialBroker, after.credentialBroker)) {
    restartRequired.push('credential_broker');
  }
  const channelTopologyChanged = !jsonEqual(
    channelTopology(before),
    channelTopology(after),
  );
  if (channelTopologyChanged) {
    restartRequired.push('channels');
  }
  if (!channelTopologyChanged && !jsonEqual(before.channels, after.channels)) {
    liveApplied.push('channel_allowlists');
  }
  if (!jsonEqual(before.agent, after.agent)) {
    liveApplied.push('agent_defaults');
  }
  if (!jsonEqual(before.agents, after.agents)) {
    restartRequired.push('agents');
  }
  if (!jsonEqual(before.memory, after.memory)) {
    restartRequired.push('memory');
  }

  return {
    liveApplied: [...new Set(liveApplied)].sort(),
    restartRequired: [...new Set(restartRequired)].sort(),
  };
}

export function agentIdForFolder(folder: string): AgentId {
  return (folder.startsWith('agent:') ? folder : `agent:${folder}`) as AgentId;
}

function folderForAgentId(agentId: AgentId): string | null {
  const raw = String(agentId);
  return raw.startsWith('agent:') ? raw.slice('agent:'.length) : null;
}

function hasAnyCapability(capabilities: RuntimeConfiguredAgentCapabilities) {
  return (
    capabilities.toolIds.length > 0 ||
    capabilities.skillIds.length > 0 ||
    capabilities.mcpServerIds.length > 0
  );
}

function activeCapabilities(
  toolBindings: AgentToolBinding[],
  skillBindings: AgentSkillBinding[],
  mcpBindings: AgentMcpServerBinding[],
): RuntimeConfiguredAgentCapabilities {
  return {
    toolIds: toolBindings
      .filter((binding) => binding.status === 'active')
      .map((binding) => binding.toolId),
    skillIds: skillBindings
      .filter((binding) => binding.status === 'active')
      .map((binding) => binding.skillId),
    mcpServerIds: mcpBindings
      .filter((binding) => binding.status === 'active')
      .map((binding) => binding.serverId),
  };
}

function mergeDmAccess(
  existing: RuntimeConfiguredAgent['dmAccess'],
  access: Array<{ provider: string; externalUserId: string }>,
  approvers: Array<{ provider: string; externalUserId: string }>,
): RuntimeConfiguredAgent['dmAccess'] {
  if (existing.length > 0) return existing;
  const providers = new Map<string, Set<string>>();
  for (const entry of access) {
    const set = providers.get(entry.provider) ?? new Set<string>();
    set.add(entry.externalUserId);
    providers.set(entry.provider, set);
  }
  return [...providers.entries()].map(([provider, userIds]) => ({
    provider,
    userIds: [...userIds].sort(),
    adminUserId: approvers.find((entry) => entry.provider === provider)
      ?.externalUserId,
  }));
}

function stableBindingId(
  jid: string,
  existing: Record<string, unknown>,
): string {
  const matching = Object.entries(existing).find(
    ([, binding]) =>
      binding &&
      typeof binding === 'object' &&
      'jid' in binding &&
      (binding as { jid?: unknown }).jid === jid,
  );
  if (matching) return matching[0];
  const base = jid.replace(/[^A-Za-z0-9_.:@-]/g, '_').slice(0, 80) || 'primary';
  if (!Object.hasOwn(existing, base)) return base;
  const hash = createHash('sha256').update(jid).digest('hex').slice(0, 12);
  return `${base}_${hash}`.slice(0, 96);
}

function channelTopology(settings: RuntimeSettings): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settings.channels).map(([channelId, channel]) => [
      channelId,
      { enabled: channel.enabled },
    ]),
  );
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
