// DEV/TESTING ONLY. GANTRY_TEST_OPERATOR_PHONE configures the test operator's own
// number. When set with at least one valid number, explicit entries and inbound
// conversation numbers whose digits start with 000 are treated as dev/test
// operators. It does two things (both no-ops when unset, i.e. production):
//   1. Outbound redirect: every reply is rerouted to the operator number so a
//      test can never reach a real customer (see channel-wiring sendMessage).
//   2. Session-command allowance: the operator may run /new etc. without being a
//      production approver (see isTestOperatorJid).
//
// Set it (in $GANTRY_HOME/.env or the process env) to the operator's digits
// (e.g. 919654405340). A comma/whitespace-separated LIST configures several
// operator numbers (e.g. "919654405340,919654405341") for parallel test lanes.
// 000-prefixed dev numbers are inferred and do not need to be listed. The FIRST
// configured entry is still the outbound redirect target.
//
// `shared` may not import `config`, so this reads process.env (the value is
// hydrated from .env at startup; see app/index.ts -> hydrateDynamicRuntimeEnv).
const OPERATOR_ENV = 'GANTRY_TEST_OPERATOR_PHONE';
const DEV_OPERATOR_DIGIT_PREFIX = '000';

// Strip a channel prefix (e.g. "wa:") leaving the dialled digits, so a JID can be
// compared against the configured operator number(s). Mirrors the historical
// `^\D*` strip so single-operator behaviour is byte-for-byte unchanged.
function jidDigits(jid: string): string {
  return jid.replace(/^\D*/, '');
}

// Parse the operator env into a normalized list of digit-strings. Splits on commas
// and whitespace, strips any decoration (prefixes, dashes, spaces) from each entry,
// and drops blanks — so "wa:919654405340, 91-965-4405341" -> two clean numbers.
function configuredOperatorPhones(): string[] {
  const raw = process.env[OPERATOR_ENV];
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.replace(/\D/g, ''))
    .filter((digits) => digits.length > 0);
}

// The full set of configured operator phones (empty when unset).
export function testOperatorPhones(): Set<string> {
  return new Set(configuredOperatorPhones());
}

// Back-compat single value: the first configured operator phone, or undefined when
// unset. Prefer testOperatorPhones() for set-aware logic.
export function testOperatorPhone(): string | undefined {
  return configuredOperatorPhones()[0];
}

// DEV/TESTING ONLY. True only when GANTRY_TEST_OPERATOR_PHONE has at least one
// valid configured phone AND `jid` is either one of the configured operator
// conversations or a 000-prefixed dev/test conversation. Lets a test operator
// reset their own session (/new) and run other session commands without being a
// production control approver — so the scenario harness can isolate each run
// (including one lane per operator number). It is STRICT: with the operator
// unset or containing no valid digits it always returns false, so it is a hard
// no-op in production (where the flag is never set).
export function isTestOperatorJid(jid: string): boolean {
  const operators = testOperatorPhones();
  if (operators.size === 0) return false;
  const digits = jidDigits(jid);
  return operators.has(digits) || digits.startsWith(DEV_OPERATOR_DIGIT_PREFIX);
}
