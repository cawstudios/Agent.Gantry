import { describe, expect, it } from 'vitest';

import { permissionUpdateAllowedToolRules } from '@core/shared/permission-tool-rules.js';

describe('permission tool rule extraction', () => {
  it('extracts exact and scoped allowed tool rules from permission updates', () => {
    expect(
      permissionUpdateAllowedToolRules([
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test *' },
            { toolName: 'Read' },
          ],
        },
      ]),
    ).toEqual(['RunCommand(npm test *)', 'FileRead']);
  });

  it('normalizes safe Python script approvals to script-path wildcard rules', () => {
    expect(
      permissionUpdateAllowedToolRules([
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [
            {
              toolName: 'Bash',
              ruleContent: 'python3 /tmp/dedup-append-lead.py',
            },
            {
              toolName: 'Bash',
              ruleContent:
                'python /tmp/other-dedup-append-lead.py \'[["lead"]]\'',
            },
          ],
        },
      ]),
    ).toEqual([
      'RunCommand(/tmp/dedup-append-lead.py *)',
      'RunCommand(/tmp/other-dedup-append-lead.py *)',
    ]);
  });

  it('ignores deny, malformed, and unsupported permission update shapes', () => {
    expect(
      permissionUpdateAllowedToolRules([
        {
          type: 'addRules',
          behavior: 'deny',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
        },
        {
          type: 'removeRules',
          behavior: 'allow',
          rules: [{ toolName: 'Write' }],
        },
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [
            { toolName: '' },
            { nope: 'Bash' },
            { toolName: 'Bash(npm test *)' },
          ],
        },
      ]),
    ).toEqual([]);
  });
});
