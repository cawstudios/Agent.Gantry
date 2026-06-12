import { afterEach, describe, expect, it } from 'vitest';

import {
  isTestOperatorJid,
  testOperatorPhone,
  testOperatorPhones,
} from '@core/shared/test-mode.js';

describe('test-mode operator phones', () => {
  afterEach(() => {
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
  });

  it('is empty when no operator is configured', () => {
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
    expect(testOperatorPhone()).toBeUndefined();
    expect(testOperatorPhones().size).toBe(0);
  });

  it('parses a comma/space-separated SET of operator phones (parallel lanes)', () => {
    process.env.GANTRY_TEST_OPERATOR_PHONE =
      '919654405340, 919654405341 919654405342';
    expect(testOperatorPhones()).toEqual(
      new Set(['919654405340', '919654405341', '919654405342']),
    );
    // First entry is the back-compat single value (the outbound redirect target).
    expect(testOperatorPhone()).toBe('919654405340');
  });

  it('normalizes decorated entries to digits and drops blanks', () => {
    process.env.GANTRY_TEST_OPERATOR_PHONE =
      ' wa:919654405340 , , 91-965-4405341 ';
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
    // This must NOT default to allow — it gates session commands, so production
    // (operator unset) must be a hard no-op.
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

  it('treats 000-prefixed conversations as dev operators when a valid operator is configured', () => {
    process.env.GANTRY_TEST_OPERATOR_PHONE = '919654405340';
    expect(isTestOperatorJid('wa:000000905')).toBe(true);
    expect(isTestOperatorJid('000000905')).toBe(true);
  });

  it('does not allow 000-prefixed conversations when the operator flag is unset', () => {
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
    expect(isTestOperatorJid('wa:000000905')).toBe(false);
    expect(isTestOperatorJid('000000905')).toBe(false);
  });

  it('does not allow 000-prefixed conversations when the operator flag has no valid digits', () => {
    process.env.GANTRY_TEST_OPERATOR_PHONE = 'wa:, ,not-a-phone';
    expect(isTestOperatorJid('wa:000000905')).toBe(false);
    expect(isTestOperatorJid('000000905')).toBe(false);
  });

  it('still rejects non-000 unlisted conversations when a valid operator is configured', () => {
    process.env.GANTRY_TEST_OPERATOR_PHONE = '919654405340';
    expect(isTestOperatorJid('wa:919999999999')).toBe(false);
    expect(isTestOperatorJid('919999999999')).toBe(false);
  });
});
