// Process-lifetime cache of compiled system prompts. The authored files are
// synced into the prompt-profile store once per boot (see
// authored-prompt-boot-sync.ts), and the process restarts on boot, so a plain
// in-memory map is always consistent with the current boot's prompt state —
// no invalidation needed within a process. Keyed by the full compile identity
// (appId/agentId/persona), not just folder, so per-route persona overrides
// never collide.
const compiledByKey = new Map<string, string>();

export function getCachedSystemPrompt(key: string): string | undefined {
  return compiledByKey.get(key);
}

export function setCachedSystemPrompt(key: string, prompt: string): void {
  compiledByKey.set(key, prompt);
}

export function clearCachedSystemPrompt(key?: string): void {
  if (key === undefined) compiledByKey.clear();
  else compiledByKey.delete(key);
}
