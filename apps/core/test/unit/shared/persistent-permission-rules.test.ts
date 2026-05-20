import { describe, expect, it } from 'vitest';

import {
  isPersistentRequestPermissionRuleAllowed,
  validatePersistentRequestPermissionRule,
} from '@core/shared/persistent-permission-rules.js';

describe('persistent permission rules', () => {
  it('allows exact Gantry facade tools as durable request_permission approvals', () => {
    for (const toolName of [
      'WebSearch',
      'WebRead',
      'FileSearch',
      'FileRead',
      'FileEdit',
      'FileWrite',
      'AgentDelegation',
    ]) {
      expect(validatePersistentRequestPermissionRule(toolName)).toEqual({
        ok: true,
      });
      expect(isPersistentRequestPermissionRuleAllowed(toolName)).toBe(true);
    }
  });

  it('still rejects scoped non-command Gantry facade rules', () => {
    expect(
      validatePersistentRequestPermissionRule('FileEdit(src/index.ts)'),
    ).toEqual({
      ok: false,
      reason:
        'Only RunCommand supports persistent scoped tool rules; use an exact tool name for other tools.',
    });
  });

  it('still rejects provider-native exact tools after facade replacement', () => {
    expect(validatePersistentRequestPermissionRule('Read')).toMatchObject({
      ok: false,
    });
    expect(validatePersistentRequestPermissionRule('Write')).toMatchObject({
      ok: false,
    });
    expect(validatePersistentRequestPermissionRule('Task')).toMatchObject({
      ok: false,
    });
  });
});
