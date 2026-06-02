// DEV/TESTING ONLY. Scopes test behaviour (the Shopify caller-identity override
// and outbound dry-run) to a configured set of operator conversations, so those
// flags are safe to enable on a server that also receives real traffic: only the
// configured operator number(s) are affected; every other caller behaves normally.
//
// Set GANTRY_TEST_OPERATOR_PHONE (in $GANTRY_HOME/.env or the process env) to the
// operator's digits (e.g. 919654405340). A comma/whitespace-separated LIST
// configures several operator conversations at once
// (e.g. "919654405340,919654405341"), which lets the scenario harness drive
// multiple isolated lanes in parallel — each lane is its own conversation but all
// share the test caller identity and outbound dry-run. If it is unset, test mode
// is UNSCOPED (applies to all callers) — only do that on a fully isolated dev
// instance.
//
// `shared` may not import `config`, so this reads process.env (the value is
// hydrated from .env at startup; see app/index.ts -> hydrateDynamicRuntimeEnv).
const OPERATOR_ENV = 'GANTRY_TEST_OPERATOR_PHONE';

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

export function jidInTestScope(jid: string): boolean {
  const operators = testOperatorPhones();
  // Unset => unscoped (applies to all). Otherwise the JID must be one of the
  // configured operator conversations.
  if (operators.size === 0) return true;
  return operators.has(jidDigits(jid));
}

// DEV/TESTING ONLY. True only when GANTRY_TEST_OPERATOR_PHONE is set AND `jid`
// is one of the configured operator conversations. Lets a test operator reset
// their own session (/new) and run other session commands without being a
// production control approver — so the scenario harness can isolate each run
// (including one lane per operator number). Unlike jidInTestScope, this is
// STRICT: with the operator unset it always returns false, so it is a hard no-op
// in production (where the flag is never set).
export function isTestOperatorJid(jid: string): boolean {
  const operators = testOperatorPhones();
  if (operators.size === 0) return false;
  return operators.has(jidDigits(jid));
}
