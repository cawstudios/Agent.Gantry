import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';

export function maintenanceCompactionPromptForExecutionProvider(
  executionProviderId: string,
  input: {
    executionAdapter?: AgentExecutionAdapter;
    executionAdapters?: AgentExecutionAdapterRegistry;
  },
): string | undefined {
  const adapter =
    input.executionAdapters?.get(executionProviderId) ??
    (input.executionAdapter?.id === executionProviderId
      ? input.executionAdapter
      : undefined);
  return adapter?.sessionCompactionPrompt?.();
}
