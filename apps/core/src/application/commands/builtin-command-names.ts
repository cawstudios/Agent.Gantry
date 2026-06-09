/**
 * Built-in command names owned by core (see session-commands.ts). An agent
 * command may not shadow one of these; the settings parser rejects collisions
 * at load time.
 *
 * Kept in its own file (no side-effectful imports) so the settings parser can
 * import this constant without pulling in the full command-registry module.
 */
export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'commands',
  'compact',
  'new',
  'stop',
  'dream',
  'memory-status',
  'digest-session',
  'extract-memory-facts',
  'models',
  'status',
  'model',
  'save-procedure',
  'thinking',
]);
