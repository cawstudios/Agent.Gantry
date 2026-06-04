#!/usr/bin/env node
// After a capture run: for each scenario, verify the boondi_business_records row matches
// expectRecord, both message directions persist, and the dashboard's own API surfaces them.
// Emits a markdown report. Read-only against app data.
import fs from 'node:fs';
import pg from 'pg';
const { Client } = pg;

const SCEN = process.argv[2] || 'scripts/interakt-test-scenarios-capture.json';
const OUT = process.argv[3] || 'artifacts/boondi-capture-report.md';
const DASH = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';
const CONN = process.env.BOONDI_CRM_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = process.env.BOONDI_CRM_DB_SCHEMA || 'gantry';

const cfg = JSON.parse(fs.readFileSync(SCEN, 'utf8'));
const client = new Client({ connectionString: CONN });
await client.connect();
await client.query(`set search_path to ${SCHEMA}`);

const getJson = async (u) => {
  try {
    const r = await fetch(u, { cache: 'no-store' });
    return await r.json();
  } catch (e) {
    return { __error: String(e) };
  }
};
const lines = [`# Boondi capture verification — ${new Date().toISOString()}`, ''];
let pass = 0;
let fail = 0;

for (const s of cfg.scenarios) {
  const phone = s.phone;
  const convId = `conversation:wa:${phone}`;
  const exp = s.expectRecord || {};
  const failures = [];

  const rec = (
    await client.query(
      `select status,intent_category,buyer_type,location_scope,customisation,score,band,source,occasion,quantity
         from boondi_business_records where phone=$1 order by updated_at desc limit 1`,
      [phone],
    )
  ).rows[0];

  if (exp.absent) {
    if (rec) failures.push(`expected NO record, found status=${rec.status}`);
  } else if (!rec) {
    failures.push('expected a record, none found');
  } else {
    if (exp.status && rec.status !== exp.status) failures.push(`status expected ${exp.status}, got ${rec.status}`);
    if (exp.intentCategory && rec.intent_category !== exp.intentCategory)
      failures.push(`intent expected ${exp.intentCategory}, got ${rec.intent_category}`);
    if (exp.buyerType && rec.buyer_type !== exp.buyerType) failures.push(`buyerType expected ${exp.buyerType}, got ${rec.buyer_type}`);
    if (exp.locationScope && rec.location_scope !== exp.locationScope)
      failures.push(`locationScope expected ${exp.locationScope}, got ${rec.location_scope}`);
    if (exp.customisation && rec.customisation !== exp.customisation)
      failures.push(`customisation expected ${exp.customisation}, got ${rec.customisation}`);
    if (exp.source && rec.source !== exp.source) failures.push(`source expected ${exp.source}, got ${rec.source}`);
    if (exp.scored && typeof rec.score !== 'number') failures.push('expected a numeric score');
    if (exp.minScore != null && !(rec.score >= exp.minScore)) failures.push(`score expected >= ${exp.minScore}, got ${rec.score}`);
  }

  const counts = (
    await client.query(`select direction, count(*)::int n from messages where conversation_id=$1 group by direction`, [convId])
  ).rows;
  const inN = counts.find((c) => c.direction === 'inbound')?.n || 0;
  const outN = counts.find((c) => c.direction === 'outbound')?.n || 0;
  if (inN === 0) failures.push('no inbound messages persisted');
  if (!exp.absent && outN === 0 && !s.reconciler) failures.push('no outbound (Boondi) messages persisted (mirror?)');

  const apiRecords = await getJson(`${DASH}/api/records`);
  const inDash = Array.isArray(apiRecords.records) && apiRecords.records.some((r) => r.phone === phone);
  if (!exp.absent && !inDash) failures.push('record not visible via dashboard /api/records');
  const apiMsgs = await getJson(`${DASH}/api/messages?conversationId=${encodeURIComponent(convId)}`);
  const dashInbound = (apiMsgs.messages || []).some((m) => m.direction === 'inbound');
  const dashOutbound = (apiMsgs.messages || []).some((m) => m.direction === 'outbound');

  const ok = failures.length === 0;
  ok ? pass++ : fail++;
  lines.push(`## ${ok ? '✅' : '❌'} ${s.name}  (${phone})`);
  if (rec)
    lines.push(
      `- record: status=**${rec.status}** intent=${rec.intent_category} buyer=${rec.buyer_type ?? '-'} score=${rec.score ?? '-'} band=${rec.band ?? '-'} source=${rec.source}`,
    );
  else lines.push(`- record: (none)`);
  lines.push(
    `- messages: inbound=${inN} outbound=${outN}  · dashboard both-sides: inbound=${dashInbound} outbound=${dashOutbound} · record-in-dash=${inDash}`,
  );
  if (!ok) for (const f of failures) lines.push(`  - ⚠️ ${f}`);
  lines.push('');
}

await client.end();
lines.unshift(`**${pass} passed, ${fail} failed**`, '');
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
console.log(lines.join('\n'));
process.exit(fail === 0 ? 0 : 1);
