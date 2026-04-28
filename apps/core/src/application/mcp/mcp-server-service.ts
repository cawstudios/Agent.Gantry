import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentMcpServerBinding,
  MaterializedMcpServer,
  McpCredentialRef,
  McpServerDefinition,
  McpServerId,
  McpServerTransportConfig,
  McpServerVersion,
  McpServerVersionId,
} from '../../domain/mcp/mcp-servers.js';
import {
  assertNoRawSecretsInMcpConfig,
  assertValidMcpServerName,
  isMcpServerApproved,
  normalizeMcpServerName,
} from '../../domain/mcp/mcp-servers.js';
import type {
  AgentRepository,
  McpServerRepository,
} from '../../domain/ports/repositories.js';
import type { PermissionPolicyId } from '../../domain/permissions/permissions.js';
import { ApplicationError } from '../common/application-error.js';
import {
  RemoteMcpDnsValidationCache,
  STDIO_TEMPLATE_COMMANDS,
  assertRemoteMcpDestinationPublic,
  validateCredentialRefs,
  validateTransportConfig,
} from './mcp-server-policy.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';

export type SdkMcpServerConfig =
  | {
      type?: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> };

export interface MaterializedMcpCapability {
  name: string;
  config: SdkMcpServerConfig;
  autoApproveToolNames: string[];
  required: boolean;
}

export class McpServerService {
  constructor(
    private readonly mcpServers: McpServerRepository,
    private readonly agents?: AgentRepository,
    private readonly options: {
      lookupHostname?: HostnameLookup;
      dnsValidationCache?: RemoteMcpDnsValidationCache;
      auditMaterialization?: boolean;
    } = {},
  ) {}

  async createDraft(input: {
    appId: AppId;
    name: string;
    displayName?: string;
    description?: string;
    createdBy?: string;
    createdSource?: McpServerDefinition['createdSource'];
    requestedReason?: string;
    transportConfig: McpServerTransportConfig;
    allowedToolPatterns?: string[];
    autoApproveToolPatterns?: string[];
    credentialRefs?: McpCredentialRef[];
    sandboxProfileId?: string;
    riskClass?: McpServerDefinition['riskClass'];
  }): Promise<{ definition: McpServerDefinition; version: McpServerVersion }> {
    const name = normalizeMcpServerName(input.name);
    assertValidMcpServerName(name);
    validateTransportConfig(input.transportConfig, {
      sandboxProfileId: input.sandboxProfileId,
    });
    assertNoRawSecretsInMcpConfig(input.transportConfig);
    validateCredentialRefs(input.credentialRefs ?? []);

    const existing = await this.mcpServers.getServerByName({
      appId: input.appId,
      name,
    });
    if (existing) {
      throw new ApplicationError(
        'CONFLICT',
        `MCP server already exists: ${name}`,
      );
    }

    const now = new Date().toISOString();
    const serverId = `mcp:${globalThis.crypto.randomUUID()}` as McpServerId;
    const definition: McpServerDefinition = {
      id: serverId,
      appId: input.appId,
      name,
      displayName: input.displayName,
      description: input.description,
      status: 'draft',
      createdSource: input.createdSource ?? 'admin',
      riskClass: input.riskClass ?? 'medium',
      requestedBy: input.createdBy,
      requestedReason: input.requestedReason,
      createdAt: now,
      updatedAt: now,
    };
    const version = buildVersion({
      appId: input.appId,
      serverId,
      version: 1,
      transportConfig: input.transportConfig,
      allowedToolPatterns: input.allowedToolPatterns ?? [],
      autoApproveToolPatterns: input.autoApproveToolPatterns ?? [],
      credentialRefs: input.credentialRefs ?? [],
      sandboxProfileId: input.sandboxProfileId,
    });
    await this.mcpServers.saveServer(definition);
    await this.mcpServers.saveVersion(version);
    await this.audit({
      appId: input.appId,
      serverId,
      versionId: version.id,
      eventType: 'request',
      actorId: input.createdBy,
      reason: input.requestedReason,
      metadata: { createdSource: definition.createdSource },
    });
    return { definition, version };
  }

  async listServers(input: {
    appId: AppId;
    statuses?: McpServerDefinition['status'][];
  }): Promise<McpServerDefinition[]> {
    return this.mcpServers.listServers(input);
  }

  async approveDraft(input: {
    appId: AppId;
    serverId: McpServerId;
    approvedBy?: string;
  }): Promise<McpServerDefinition> {
    const server = await this.requireServer(input.appId, input.serverId);
    if (server.status !== 'draft') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Only draft MCP servers can be approved: ${server.id}`,
      );
    }
    const versions = await this.mcpServers.listVersions(server.id);
    const version = versions[0];
    if (!version) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `MCP server draft has no version: ${server.id}`,
      );
    }
    await assertRemoteMcpDestinationPublic(
      version.config,
      this.options.lookupHostname,
      { cache: this.options.dnsValidationCache },
    );
    const now = new Date().toISOString();
    const approved: McpServerDefinition = {
      ...server,
      status: 'approved',
      latestApprovedVersionId: version.id,
      approvedBy: input.approvedBy,
      approvedAt: now,
      updatedAt: now,
    };
    const reviewedVersion: McpServerVersion = {
      ...version,
      reviewedBy: input.approvedBy,
      reviewedAt: now,
    };
    await this.mcpServers.saveVersion(reviewedVersion);
    await this.mcpServers.saveServer(approved);
    await this.audit({
      appId: input.appId,
      serverId: server.id,
      versionId: version.id,
      eventType: 'approve',
      actorId: input.approvedBy,
    });
    return approved;
  }

  async rejectDraft(input: {
    appId: AppId;
    serverId: McpServerId;
    rejectedBy?: string;
    reason?: string;
  }): Promise<McpServerDefinition> {
    const server = await this.requireServer(input.appId, input.serverId);
    if (server.status !== 'draft') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Only draft MCP servers can be rejected: ${server.id}`,
      );
    }
    const now = new Date().toISOString();
    const rejected: McpServerDefinition = {
      ...server,
      status: 'rejected',
      rejectedBy: input.rejectedBy,
      rejectedAt: now,
      updatedAt: now,
    };
    await this.mcpServers.saveServer(rejected);
    await this.audit({
      appId: input.appId,
      serverId: server.id,
      eventType: 'reject',
      actorId: input.rejectedBy,
      reason: input.reason,
    });
    return rejected;
  }

  async disableServer(input: {
    appId: AppId;
    serverId: McpServerId;
    disabledBy?: string;
    reason?: string;
  }): Promise<McpServerDefinition> {
    const server = await this.requireServer(input.appId, input.serverId);
    const now = new Date().toISOString();
    const disabled: McpServerDefinition = {
      ...server,
      status: 'disabled',
      disabledBy: input.disabledBy,
      disabledAt: now,
      updatedAt: now,
    };
    await this.mcpServers.saveServer(disabled);
    await this.audit({
      appId: input.appId,
      serverId: server.id,
      eventType: 'disable',
      actorId: input.disabledBy,
      reason: input.reason,
    });
    return disabled;
  }

  async testServer(input: {
    appId: AppId;
    serverId: McpServerId;
    testedBy?: string;
  }): Promise<{ server: McpServerDefinition; ok: true; message: string }> {
    const server = await this.requireServer(input.appId, input.serverId);
    const version = server.latestApprovedVersionId
      ? await this.mcpServers.getVersion(server.latestApprovedVersionId)
      : null;
    if (!isMcpServerApproved(server) || !version) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `MCP server must be approved before testing: ${server.id}`,
      );
    }
    validateTransportConfig(version.config, {
      sandboxProfileId: version.sandboxProfileId,
    });
    await assertRemoteMcpDestinationPublic(
      version.config,
      this.options.lookupHostname,
      { cache: this.options.dnsValidationCache },
    );
    assertNoRawSecretsInMcpConfig(version.config);
    validateCredentialRefs(version.credentialRefs);
    await this.audit({
      appId: input.appId,
      serverId: server.id,
      versionId: version.id,
      eventType: 'test',
      actorId: input.testedBy,
      metadata: { transport: version.transport },
    });
    return {
      server,
      ok: true,
      message: 'MCP server definition is approved and safe to materialize.',
    };
  }

  async bindToAgent(input: {
    appId: AppId;
    agentId: AgentId;
    serverId: McpServerId;
    versionId?: McpServerVersionId;
    required?: boolean;
    permissionPolicyIds?: PermissionPolicyId[];
  }): Promise<AgentMcpServerBinding> {
    await this.assertAgentInApp(input.appId, input.agentId);
    const server = await this.requireServer(input.appId, input.serverId);
    if (!isMcpServerApproved(server)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `MCP server must be approved before binding: ${server.id}`,
      );
    }
    const versionId = input.versionId ?? server.latestApprovedVersionId;
    if (!versionId) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `MCP server has no approved version: ${server.id}`,
      );
    }
    const version = await this.mcpServers.getVersion(versionId);
    if (
      !version ||
      version.appId !== input.appId ||
      version.serverId !== input.serverId
    ) {
      throw new ApplicationError(
        'NOT_FOUND',
        `MCP server version not found: ${versionId}`,
      );
    }
    const now = new Date().toISOString();
    const binding: AgentMcpServerBinding = {
      id: `agent-mcp-binding:${input.agentId}:${input.serverId}` as AgentMcpServerBinding['id'],
      appId: input.appId,
      agentId: input.agentId,
      serverId: input.serverId,
      versionId,
      status: 'active',
      required: input.required ?? false,
      permissionPolicyIds: input.permissionPolicyIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.mcpServers.saveAgentBinding(binding);
    await this.audit({
      appId: input.appId,
      agentId: input.agentId,
      serverId: input.serverId,
      versionId,
      bindingId: binding.id,
      eventType: 'bind',
    });
    return binding;
  }

  async unbindFromAgent(input: {
    appId: AppId;
    agentId: AgentId;
    serverId: McpServerId;
  }): Promise<AgentMcpServerBinding | null> {
    await this.assertAgentInApp(input.appId, input.agentId);
    const binding = await this.mcpServers.disableAgentBinding({
      ...input,
      updatedAt: new Date().toISOString(),
    });
    if (binding) {
      await this.audit({
        appId: input.appId,
        agentId: input.agentId,
        serverId: input.serverId,
        versionId: binding.versionId,
        bindingId: binding.id,
        eventType: 'unbind',
      });
    }
    return binding;
  }

  async listAgentBindings(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentMcpServerBinding[]> {
    await this.assertAgentInApp(input.appId, input.agentId);
    return this.mcpServers.listAgentBindings(input);
  }

  async materializeForAgent(input: {
    appId: AppId;
    agentId: AgentId;
    credentialEnv?: Record<string, string>;
  }): Promise<MaterializedMcpCapability[]> {
    const records =
      await this.mcpServers.listMaterializedServersForAgent(input);
    const capabilities = await Promise.all(
      records.map(async (record) => {
        validateTransportConfig(record.version.config, {
          sandboxProfileId: record.version.sandboxProfileId,
        });
        await assertRemoteMcpDestinationPublic(
          record.version.config,
          this.options.lookupHostname,
          { cache: this.options.dnsValidationCache },
        );
        assertNoRawSecretsInMcpConfig(record.version.config);
        validateCredentialRefs(record.version.credentialRefs);
        return materializeRecord(record, input.credentialEnv ?? {});
      }),
    );
    if (this.options.auditMaterialization ?? true) {
      const recordsByName = new Map(
        records.map((record) => [record.definition.name, record]),
      );
      for (const capability of capabilities) {
        const record = recordsByName.get(capability.name);
        await this.audit({
          appId: input.appId,
          agentId: input.agentId,
          serverId: record?.definition.id,
          versionId: record?.version.id,
          bindingId: record?.binding.id,
          eventType: 'materialize',
          metadata: { name: capability.name, required: capability.required },
        });
      }
    }
    return capabilities;
  }

  async requireServer(
    appId: AppId,
    serverId: McpServerId,
  ): Promise<McpServerDefinition> {
    const server = await this.mcpServers.getServer(serverId);
    if (!server || server.appId !== appId) {
      throw new ApplicationError(
        'NOT_FOUND',
        `MCP server not found: ${serverId}`,
      );
    }
    return server;
  }

  private async assertAgentInApp(
    appId: AppId,
    agentId: AgentId,
  ): Promise<void> {
    if (!this.agents) return;
    const agent = await this.agents.getAgent(agentId);
    if (!agent || agent.appId !== appId) {
      throw new ApplicationError('NOT_FOUND', `Agent not found: ${agentId}`);
    }
  }

  private async audit(
    input: Omit<
      Parameters<McpServerRepository['appendAuditEvent']>[0],
      'id' | 'createdAt' | 'metadata'
    > & {
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.mcpServers.appendAuditEvent({
      id: `mcp-audit:${globalThis.crypto.randomUUID()}` as never,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
      ...input,
    });
  }
}

function buildVersion(input: {
  appId: AppId;
  serverId: McpServerId;
  version: number;
  transportConfig: McpServerTransportConfig;
  allowedToolPatterns: string[];
  autoApproveToolPatterns: string[];
  credentialRefs: McpCredentialRef[];
  sandboxProfileId?: string;
}): McpServerVersion {
  const configHash = hashMcpConfig({
    config: input.transportConfig,
    allowedToolPatterns: input.allowedToolPatterns,
    autoApproveToolPatterns: input.autoApproveToolPatterns,
    credentialRefs: input.credentialRefs,
    sandboxProfileId: input.sandboxProfileId,
  });
  return {
    id: `mcp-version:${globalThis.crypto.randomUUID()}` as McpServerVersionId,
    appId: input.appId,
    serverId: input.serverId,
    version: input.version,
    transport: input.transportConfig.transport,
    config: input.transportConfig,
    allowedToolPatterns: input.allowedToolPatterns,
    autoApproveToolPatterns: input.autoApproveToolPatterns,
    credentialRefs: input.credentialRefs,
    sandboxProfileId: input.sandboxProfileId,
    configHash,
    createdAt: new Date().toISOString(),
  };
}

function hashMcpConfig(value: unknown): string {
  const serialized = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

function materializeRecord(
  record: MaterializedMcpServer,
  credentialEnv: Record<string, string>,
): MaterializedMcpCapability {
  const config = record.version.config;
  const credentialValues = resolveCredentialValues(
    record.version.credentialRefs,
    credentialEnv,
  );
  const autoApproveToolNames = record.version.autoApproveToolPatterns.map(
    (tool) => `mcp__${record.definition.name}__${tool}`,
  );
  if (config.transport === 'http' || config.transport === 'sse') {
    const headers = {
      ...(config.headers ?? {}),
      ...credentialValues.headers,
    };
    return {
      name: record.definition.name,
      config: {
        type: config.transport,
        url: config.url!,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      autoApproveToolNames,
      required: record.binding.required,
    };
  }

  const template = STDIO_TEMPLATE_COMMANDS[config.templateId ?? ''];
  const env = {
    ...(config.env ?? {}),
    ...credentialValues.env,
  };
  return {
    name: record.definition.name,
    config: {
      type: 'stdio',
      command: template.command,
      args: [...template.args, ...(config.args ?? [])],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
    autoApproveToolNames,
    required: record.binding.required,
  };
}

function resolveCredentialValues(
  refs: McpCredentialRef[],
  credentialEnv: Record<string, string>,
): { env: Record<string, string>; headers: Record<string, string> } {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const ref of refs) {
    const value = credentialEnv[ref.name];
    if (!value) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Missing broker credential for MCP credential ref: ${ref.name}`,
      );
    }
    if (ref.target === 'env') env[ref.key] = value;
    else headers[ref.key] = value;
  }
  return { env, headers };
}
