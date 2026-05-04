const MCP_WILDCARD_RE = /^mcp__([A-Za-z0-9_-]+)__\*$/;

export interface ToolRuleValidationResult {
  ok: boolean;
  reason?: string;
}

export function normalizeToolRules(
  rules: readonly unknown[] | undefined,
): string[] {
  if (!Array.isArray(rules)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rules) {
    const rule = typeof raw === 'string' ? raw.trim() : '';
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    out.push(rule);
  }
  return out;
}

export function validateAutonomousToolRule(
  rule: string,
): ToolRuleValidationResult {
  const value = rule.trim();
  if (!value) return { ok: false, reason: 'Tool rule cannot be empty.' };
  if (value === '*') {
    return { ok: false, reason: 'Global wildcard tool rule is not allowed.' };
  }
  if (value.includes('*')) {
    if (MCP_WILDCARD_RE.test(value)) return { ok: true };
    return {
      ok: false,
      reason: 'Wildcard tool rules must use mcp__server__* form.',
    };
  }
  return { ok: true };
}

export function validateAutonomousToolRules(
  rules: readonly string[],
): ToolRuleValidationResult {
  for (const rule of rules) {
    const result = validateAutonomousToolRule(rule);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function toolRuleMatches(rule: string, toolName: string): boolean {
  const normalizedRule = rule.trim();
  if (!normalizedRule) return false;
  const wildcard = MCP_WILDCARD_RE.exec(normalizedRule);
  if (wildcard) return toolName.startsWith(`mcp__${wildcard[1]}__`);
  return normalizedRule === toolName;
}

export function anyToolRuleMatches(
  rules: readonly string[],
  toolName: string,
): boolean {
  return rules.some((rule) => toolRuleMatches(rule, toolName));
}
