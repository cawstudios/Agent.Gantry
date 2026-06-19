export interface PreRunMcpCallInput {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface AgentPreRunContextInput {
  agentFolder: string;
  agentId?: string;
  conversationJid: string;
  conversationKind?: 'dm' | 'channel';
  memoryUserId?: string;
  hasRecentSessionDigest: boolean;
  memoryContextBlock?: string;
  callMcpTool: (input: PreRunMcpCallInput) => Promise<unknown>;
  log: {
    info: (metadata: Record<string, unknown>, message: string) => void;
    warn: (metadata: Record<string, unknown>, message: string) => void;
  };
}

export interface AgentPreRunContextProvider {
  name: string;
  build(input: AgentPreRunContextInput): Promise<string | null | undefined>;
}

export function isAgentPreRunContextProvider(
  value: unknown,
): value is AgentPreRunContextProvider {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.build === 'function';
}
