export const RELATIONSHIP_MODES = ['personal', 'organization'] as const;

export type AgentRelationshipMode = (typeof RELATIONSHIP_MODES)[number];

export const DEFAULT_RELATIONSHIP_MODE: AgentRelationshipMode = 'personal';

export function resolveAgentRelationshipMode(
  value: unknown,
): AgentRelationshipMode {
  if (typeof value !== 'string') return DEFAULT_RELATIONSHIP_MODE;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  return (RELATIONSHIP_MODES as readonly string[]).includes(normalized)
    ? (normalized as AgentRelationshipMode)
    : DEFAULT_RELATIONSHIP_MODE;
}

export function parseAgentRelationshipMode(
  value: unknown,
  path: string,
): AgentRelationshipMode {
  if (value === undefined) return DEFAULT_RELATIONSHIP_MODE;
  if (typeof value !== 'string') {
    throw new Error(`${path} must be one of ${RELATIONSHIP_MODES.join(', ')}`);
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (!(RELATIONSHIP_MODES as readonly string[]).includes(normalized)) {
    throw new Error(`${path} must be one of ${RELATIONSHIP_MODES.join(', ')}`);
  }
  return normalized as AgentRelationshipMode;
}
