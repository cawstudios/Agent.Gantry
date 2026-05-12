import { isKnownProjectedBrowserMcpToolName } from '../../shared/agent-tool-references.js';

export function synthesizePermissionSuggestions(
  toolName: string,
  options: { blockedPath?: string },
): unknown[] | undefined {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) return undefined;
  const ruleContent = inferPermissionRuleContent(options);
  if (!ruleContent) return undefined;
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: [
        {
          toolName: normalizedToolName,
          ...(ruleContent ? { ruleContent } : {}),
        },
      ],
    },
  ];
}

export function scheduledPermissionSuggestions(
  toolName: string,
  sdkSuggestions: readonly unknown[] | undefined,
  options: { blockedPath?: string },
): unknown[] | undefined {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) return undefined;
  if (isKnownProjectedBrowserMcpToolName(normalizedToolName)) {
    return browserPermissionSuggestion();
  }
  if ((sdkSuggestions?.length ?? 0) > 0) return [...(sdkSuggestions ?? [])];
  return synthesizePermissionSuggestions(normalizedToolName, {
    blockedPath: options.blockedPath,
  });
}

export function browserPermissionSuggestion(): unknown[] {
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: [
        {
          toolName: 'Browser',
        },
      ],
    },
  ];
}

export function permissionRequestToolName(toolName: string): string {
  return isKnownProjectedBrowserMcpToolName(toolName.trim())
    ? 'Browser'
    : toolName;
}

function inferPermissionRuleContent(options: {
  blockedPath?: string;
}): string | undefined {
  const scope = trimmed(options.blockedPath);
  if (!scope) return undefined;
  return scope;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const out = value.trim();
  return out || undefined;
}
