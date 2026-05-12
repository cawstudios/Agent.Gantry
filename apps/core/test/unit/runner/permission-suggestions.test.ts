import { describe, expect, it } from 'vitest';

import { scheduledPermissionSuggestions } from '@core/runner/claude/permission-suggestions.js';

describe('scheduledPermissionSuggestions', () => {
  it('canonicalizes projected browser tool suggestions to Browser', () => {
    expect(
      scheduledPermissionSuggestions(
        'mcp__myclaw__browser_navigate',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'mcp__myclaw__browser_navigate' }],
          },
        ],
        {},
      ),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Browser' }],
      },
    ]);
  });

  it('keeps SDK suggestions for non-browser tools', () => {
    const sdkSuggestions = [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
      },
    ];

    expect(scheduledPermissionSuggestions('Bash', sdkSuggestions, {})).toEqual(
      sdkSuggestions,
    );
  });
});
