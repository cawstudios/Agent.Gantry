export const CLAUDE_MODEL_PINS = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
} as const;

export const CLAUDE_CODE_MODEL_ALIASES = [
  'sonnet',
  'opus',
  'haiku',
  'best',
  'opusplan',
  'sonnet[1m]',
  'opus[1m]',
] as const;

export const CLAUDE_CODE_PINNED_MODELS = [] as readonly string[];

export const CLAUDE_CODE_ALLOWED_MODELS = [
  ...CLAUDE_CODE_MODEL_ALIASES,
  ...CLAUDE_CODE_PINNED_MODELS,
] as const;

export const DEFAULT_SETUP_MODEL = 'opus';

export const MEMORY_MODEL_DEFAULTS = {
  extractor: CLAUDE_MODEL_PINS.haiku,
  dreaming: CLAUDE_MODEL_PINS.sonnet,
  consolidation: CLAUDE_MODEL_PINS.sonnet,
} as const;

export const CLAUDE_CODE_MODEL_PIN_ENV = {};

export const CLAUDE_CODE_MODEL_PIN_ENV_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

const MODEL_SHORTHANDS: Record<string, string> = {
  'opus-4-7': 'opus',
  'opus-4.7': 'opus',
  'claude-opus-4.7': 'opus',
  'opus-4-6': CLAUDE_MODEL_PINS.opus,
  'opus-4.6': CLAUDE_MODEL_PINS.opus,
  'claude-opus-4.6': CLAUDE_MODEL_PINS.opus,
  'sonnet-4-6': CLAUDE_MODEL_PINS.sonnet,
  'sonnet-4.6': CLAUDE_MODEL_PINS.sonnet,
  'claude-sonnet-4.6': CLAUDE_MODEL_PINS.sonnet,
  'haiku-4-5': CLAUDE_MODEL_PINS.haiku,
  'haiku-4.5': CLAUDE_MODEL_PINS.haiku,
  'claude-haiku-4.5': CLAUDE_MODEL_PINS.haiku,
  'haiku-4-5-20251001': CLAUDE_MODEL_PINS.haiku,
};

export function normalizeClaudeModelSelection(
  value?: string | null,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const normalized = trimmed.toLowerCase();
  if (normalized in MODEL_SHORTHANDS) {
    return MODEL_SHORTHANDS[normalized];
  }

  const allowedAlias = CLAUDE_CODE_MODEL_ALIASES.find(
    (alias) => alias.toLowerCase() === normalized,
  );
  if (allowedAlias) return allowedAlias;

  const pinnedModel = CLAUDE_CODE_PINNED_MODELS.find(
    (model) => model.toLowerCase() === normalized,
  );
  if (pinnedModel) return pinnedModel;

  return trimmed;
}
