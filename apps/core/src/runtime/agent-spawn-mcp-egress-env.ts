import type { MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';

export function withStdioMcpEgressEnv(
  capabilities: readonly MaterializedMcpCapability[],
  toolNetworkEnv: Record<string, string | undefined>,
): MaterializedMcpCapability[] {
  const sanitizedToolNetworkEnv = Object.fromEntries(
    Object.entries(toolNetworkEnv).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  );
  return capabilities.map((capability) => {
    if (capability.config.type !== 'stdio') return capability;
    return {
      ...capability,
      config: {
        ...capability.config,
        env: {
          ...(capability.config.env ?? {}),
          ...sanitizedToolNetworkEnv,
        },
      },
    };
  });
}
