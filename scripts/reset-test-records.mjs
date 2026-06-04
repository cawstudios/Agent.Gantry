#!/usr/bin/env node
// Delete all test-persona data (conversations cascade to messages/parts/participants),
// CRM records, reconcile cursors, and memory; then seed one open lead for the
// returning-customer scenario. Boondi-side test-data setup; talks only to the shared DB.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PERSONA_PHONES, RETURNING_PHONE } from './lib/test-phones.mjs';

const { Client } = pg;
const CONN = process.env.BOONDI_CRM_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = process.env.BOONDI_CRM_DB_SCHEMA || 'gantry';
if (!CONN) {
  console.error('Set BOONDI_CRM_DATABASE_URL or DATABASE_URL');
  process.exit(2);
}

const convIds = PERSONA_PHONES.map((p) => `conversation:wa:${p}`);

const client = new Client({ connectionString: CONN });
await client.connect();
try {
  await client.query(`set search_path to ${SCHEMA}`);
  await client.query(`delete from boondi_business_records where phone = any($1)`, [PERSONA_PHONES]);
  await client
    .query(`delete from boondi_reconcile_cursor where conversation_id = any($1)`, [convIds])
    .catch(() => {});
  await client
    .query(`delete from memory_items where user_id = any($1)`, [PERSONA_PHONES])
    .catch(() => {});
  // Conversations cascade to messages -> message_parts and participants (FK onDelete cascade).
  await client.query(`delete from conversations where id = any($1)`, [convIds]);
  // Seed an open lead for the returning-customer scenario so get_open_records has something.
  await client.query(
    `insert into boondi_business_records
       (id, phone, customer_name, conversation_id, status, intent_category,
        occasion, quantity, quantity_raw, buyer_type, summary_brief, source, score, band)
     values ($1,$2,$3,$4,'lead','corporate','Diwali',300,'around 300','employee_gifting',
        'Returning: ~300 Diwali boxes for the team (seeded for recognition test)','agent',77,'P2')`,
    [`bcr_${randomUUID()}`, RETURNING_PHONE, 'Aarav (Acme Corp)', `conversation:wa:${RETURNING_PHONE}`],
  );
  console.log('reset+seed ok');
} finally {
  await client.end();
}
