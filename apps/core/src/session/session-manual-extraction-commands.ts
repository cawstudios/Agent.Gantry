import type { NewMessage } from '../domain/types.js';
import type { SessionCommandDeps } from './session-commands.js';

type ManualCommandKind = 'digest_session' | 'extract_memory_facts';

export async function handleManualExtractionCommand(input: {
  kind: ManualCommandKind;
  deps: SessionCommandDeps;
  cmdMsg: Pick<NewMessage, 'timestamp' | 'id'>;
  sanitizeErrorText: (text: string) => string;
}): Promise<{ handled: true; success: true }> {
  const { deps, cmdMsg, sanitizeErrorText } = input;
  deps.advanceCursor(cmdMsg);

  if (input.kind === 'digest_session') {
    if (!deps.collectCurrentSessionMemory) {
      await deps.sendMessage('/digest-session is unavailable in this runtime.');
      return { handled: true, success: true };
    }
    try {
      const result = await deps.collectCurrentSessionMemory({
        excludeMessageIds: [cmdMsg.id],
      });
      await deps.sendMessage(
        `Digest processed. New digest: ${result.digestCreated ? 'yes' : 'no new customer turns'}. Memory facts saved: ${result.saved}.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await deps.sendMessage(
        `/digest-session failed: ${sanitizeErrorText(message)}`,
      );
    }
    return { handled: true, success: true };
  }

  if (!deps.collectCurrentSessionMemory) {
    await deps.sendMessage(
      '/extract-memory-facts is unavailable in this runtime.',
    );
    return { handled: true, success: true };
  }
  try {
    const result = await deps.collectCurrentSessionMemory({
      excludeMessageIds: [cmdMsg.id],
    });
    await deps.sendMessage(
      `Memory extraction processed. Facts saved: ${result.saved}. New digest: ${result.digestCreated ? 'yes' : 'no'}.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.sendMessage(
      `/extract-memory-facts failed: ${sanitizeErrorText(message)}`,
    );
  }
  return { handled: true, success: true };
}
