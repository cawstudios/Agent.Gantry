import type {
  AgentPreRunContextInput,
  AgentPreRunContextProvider,
} from '../application/pre-run-context/pre-run-context-types.js';

export async function buildPreRunContextBlock(input: {
  providerNames?: readonly string[];
  loadProvider: (name: string) => Promise<AgentPreRunContextProvider | null>;
  input: AgentPreRunContextInput;
}): Promise<string> {
  const blocks: string[] = [];
  for (const providerName of input.providerNames ?? []) {
    const provider = await input.loadProvider(providerName);
    if (!provider) {
      input.input.log.warn(
        { provider: providerName, agentFolder: input.input.agentFolder },
        'pre_run_context_provider_missing',
      );
      continue;
    }

    try {
      const block = (await provider.build(input.input))?.trim();
      if (block) blocks.push(block);
      // eslint-disable-next-line no-catch-all/no-catch-all -- pre-run context is additive and must never block customer replies.
    } catch (err) {
      input.input.log.warn(
        {
          provider: providerName,
          agentFolder: input.input.agentFolder,
          err: err instanceof Error ? err.message : String(err),
        },
        'pre_run_context_provider_failed',
      );
    }
  }

  return blocks.join('\n\n');
}
