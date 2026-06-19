import { McpToolProxy } from '../application/mcp/mcp-tool-proxy.js';
import type { RemoteMcpDnsValidationCache } from '../application/mcp/mcp-server-policy.js';
import { resolveMcpCredentialEnvForAgent } from '../application/capability-secrets/mcp-secret-projection.js';
import { runtimeEnvValueDynamic } from '../config/env/index.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { AppId } from '../domain/app/app.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../domain/ports/repositories.js';
import { logger } from '../infrastructure/logging/logger.js';

export function createPreRunMcpCaller(input: {
  makeProxy?: (conversationJid: string) => Pick<McpToolProxy, 'callTool'>;
  mcpServers?: McpServerRepository;
  tools?: ToolCatalogRepository;
  skills?: SkillCatalogRepository;
  capabilitySecretRepository?: CapabilitySecretRepository;
  serverIds?: readonly string[];
  lookupHostname?: HostnameLookup;
  dnsValidationCache?: RemoteMcpDnsValidationCache;
}): (call: {
  appId: string;
  agentId: string;
  conversationJid: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}) => Promise<unknown> {
  return async (call) => {
    if (!input.makeProxy && (!input.mcpServers || !input.tools)) {
      throw new Error('Pre-run MCP caller is unavailable');
    }
    const proxy =
      input.makeProxy?.(call.conversationJid) ??
      new McpToolProxy(input.mcpServers!, {
        tools: input.tools!,
        skills: input.skills,
        credentialEnv: await resolveCredentialEnv({
          appId: call.appId,
          agentId: call.agentId,
          mcpServers: input.mcpServers,
          capabilitySecretRepository: input.capabilitySecretRepository,
          serverIds: input.serverIds,
        }),
        callerIdentityJid: call.conversationJid,
        conversationJid: call.conversationJid,
        lookupHostname: input.lookupHostname,
        dnsValidationCache: input.dnsValidationCache,
      });

    return proxy.callTool({
      appId: call.appId as AppId,
      agentId: call.agentId as AgentId,
      serverName: call.serverName,
      toolName: call.toolName,
      arguments: call.arguments ?? {},
    });
  };
}

async function resolveCredentialEnv(input: {
  appId: string;
  agentId: string;
  mcpServers?: McpServerRepository;
  capabilitySecretRepository?: CapabilitySecretRepository;
  serverIds?: readonly string[];
}): Promise<Record<string, string>> {
  if (
    !input.mcpServers ||
    !input.capabilitySecretRepository ||
    !input.serverIds ||
    input.serverIds.length === 0
  ) {
    return {};
  }

  return resolveMcpCredentialEnvForAgent({
    appId: input.appId as AppId,
    agentId: input.agentId as AgentId,
    serverIds: input.serverIds as never,
    mcpServers: input.mcpServers,
    secrets: input.capabilitySecretRepository,
    readRuntimeEnv: runtimeEnvValueDynamic,
    logger,
  });
}
