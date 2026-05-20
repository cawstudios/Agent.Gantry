import { evaluateAutonomousToolUse } from '../../../../shared/tool-rule-matcher.js';

export function matchedRequiredToolRules(input: {
  requiredTools: readonly string[];
  toolName: string;
  toolInput: unknown;
}): string[] {
  const matched = new Set<string>();
  for (const rule of input.requiredTools) {
    const result = evaluateAutonomousToolUse({
      rules: [rule],
      toolName: input.toolName,
      toolInput: input.toolInput,
    });
    if (!result.allowed) continue;
    for (const matchedRule of result.matchedRules ?? []) {
      matched.add(matchedRule);
    }
    if (result.matchedRule) {
      matched.add(result.matchedRule);
    }
  }
  return [...matched];
}
