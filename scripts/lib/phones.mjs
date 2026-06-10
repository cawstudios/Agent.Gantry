import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Test phone numbers for the Boondi regression harness.
//
// INVARIANT: every number here MUST be in GANTRY_TEST_OPERATOR_PHONE
// set during a test run. With that set, each number is:
//   • outbound-scoped — dry-run sends only to listed numbers. Replies are still
//     PERSISTED so the dashboard shows both sides. A number NOT in the list is
//     never sent to.
//   • allowed to run /new (session reset between scenarios / lanes).
//   • never a real customer — so these are deliberately FAKE numbers, NOT the
//     operator's own WhatsApp (which would actually receive the test replies).
//
// Shopify identity: with GANTRY_TEST_CALLER_IDENTITY_PHONE=SHOPIFY_IDENTITY, every
// test turn's signed Shopify caller-identity resolves to SHOPIFY_IDENTITY — so
// "my own order" == SHOPIFY_IDENTITY and any other number is a privacy mismatch.
// CRM capture keys off the CONVERSATION phone (not the identity header), so each
// persona's records still land under its own number regardless of the override.

// The Shopify identity every test turn resolves to (set as GANTRY_TEST_CALLER_IDENTITY_PHONE).
export const SHOPIFY_IDENTITY = '918097288633';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_PATH = path.join(HERE, '..', 'boondi-scenarios.json');

function scenarioPhones() {
  const cfg = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  return cfg.scenarios
    .map((scenario) => normalizePhoneToken(scenario.phone))
    .filter(Boolean);
}

// conversation + shopify groups no longer share chats during normal regression
// runs; every scenario declares its own fake phone. Keep lanes only as a fallback
// for ad-hoc scenarios without an explicit phone.
export const LANE_PHONES = ['000000001', '000000002', '000000003'];

// The returning CRM scenario is seeded before execution.
export const RETURNING_PHONE = '000000050';

// isolation group: many users driven concurrently, each tagged with a distinctive
// marker, to prove no chat's content leaks into another (the bleed guard).
export const ISOLATION_PHONES = [
  '000000901',
  '000000902',
  '000000903',
  '000000904',
  '000000905',
  '000000906',
];

function normalizePhoneToken(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  return digits || null;
}

export function phonesFromEnvValue(value) {
  return new Set(
    String(value ?? '')
      .split(/[,\s]+/)
      .map(normalizePhoneToken)
      .filter(Boolean),
  );
}

function readRuntimeEnvValue(name) {
  if (process.env[name]) return process.env[name];
  const home = process.env.GANTRY_HOME || path.join(os.homedir(), 'gantry');
  try {
    const text = fs.readFileSync(path.join(home, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m?.[1] !== name) continue;
      let value = m[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    /* no runtime env file */
  }
  return '';
}

export function configuredOperatorPhones() {
  return phonesFromEnvValue(readRuntimeEnvValue('GANTRY_TEST_OPERATOR_PHONE'));
}

// The static fake-number union expected for automated runs.
export const ALL_TEST_PHONES = [...scenarioPhones(), ...ISOLATION_PHONES];
export const OPERATOR_LIST = [
  ...new Set([...ALL_TEST_PHONES, ...configuredOperatorPhones()]),
].join(',');

export function isAllowedTestPhone(phone) {
  return configuredOperatorPhones().has(normalizePhoneToken(phone));
}
