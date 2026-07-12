export type PermissionMode = 'ask' | 'auto';

export function resolveEffectivePermissionMode(
  conversationMode?: PermissionMode,
  agentMode?: PermissionMode,
): PermissionMode {
  return conversationMode ?? agentMode ?? 'ask';
}
