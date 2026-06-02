import { afterEach, describe, expect, it } from 'vitest';

import {
  isTestOperatorJid,
  jidInTestScope,
  testOperatorPhone,
  testOperatorPhones,
} from '@core/shared/test-mode.js';

describe('test-mode scoping', () => {
  afterEach(() => {
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
  });

  it('is unscoped (applies to all) when no operator is configured', () => {
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
    expect(testOperatorPhone()).toBeUndefined();
    expect(testOperatorPhones().size).toBe(0);
    expect(jidInTestScope('wa:919654405340')).toBe(true);
    expect(jidInTestScope('wa:919999999999')).toBe(true);
  });

  it('matches only the operator conversation when configured', () => {
    process.env.GANTRY_TEST_OPERATOR_PHONE = '919654405340';
    expect(jidInTestScope('wa:919654405340')).toBe(true);
    expect(jidInTestScope('wa:919999999999')).toBe(false);
    expect(jidInTestScope('tg:919654405340')).toBe(true);
  });

  it('accepts a comma/space-separated SET of operator phones (parallel lanes)', () => {
    // A pool of distinct lane numbers — each its own conversation, all in scope
    // so they share the test caller identity and outbound dry-run.
    process.env.GANTRY_TEST_OPERATOR_PHONE =
      '919654405340, 919654405341 919654405342';
    expect(testOperatorPhones()).toEqual(
      new Set(['919654405340', '919654405341', '919654405342']),
    );
    // First entry remains the back-compat single value.
    expect(testOperatorPhone()).toBe('919654405340');
    for (const p of ['919654405340', '919654405341', '919654405342']) {
      expect(jidInTestScope(`wa:${p}`)).toBe(true);
    }
    expect(jidInTestScope('wa:919999999999')).toBe(false);
  });

  it('normalizes decorated entries to digits and drops blanks', () => {
    process.env.GANTRY_TEST_OPERATOR_PHONE = ' wa:919654405340 , , 91-965-4405341 ';
    expect(testOperatorPhones()).toEqual(
      new Set(['919654405340', '919654405341']),
    );
  });
});

describe('isTestOperatorJid (session-command allowance)', () => {
  afterEach(() => {
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
  });

  it('is strict: false for every jid when no operator is configured', () => {
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
    // Unlike jidInTestScope, this must NOT default to allow — it gates session
    // commands, so production (operator unset) must be a hard no-op.
    expect(isTestOperatorJid('wa:919654405340')).toBe(false);
    expect(isTestOperatorJid('wa:919999999999')).toBe(false);
  });

  it('matches only the operator conversation (any channel prefix) when set', () => {
    process.env.GANTRY_TEST_OPERATOR_PHONE = '919654405340';
    expect(isTestOperatorJid('wa:919654405340')).toBe(true);
    expect(isTestOperatorJid('tg:919654405340')).toBe(true);
    expect(isTestOperatorJid('wa:918097288633')).toBe(false);
    expect(isTestOperatorJid('wa:919999999999')).toBe(false);
  });

  it('matches any phone in a configured set (parallel lanes reset their own session)', () => {
    process.env.GANTRY_TEST_OPERATOR_PHONE = '919654405340,919654405341';
    expect(isTestOperatorJid('wa:919654405340')).toBe(true);
    expect(isTestOperatorJid('wa:919654405341')).toBe(true);
    expect(isTestOperatorJid('wa:919654405342')).toBe(false);
  });
});
