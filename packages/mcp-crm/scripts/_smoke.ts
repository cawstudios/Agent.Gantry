// Manual repository smoke check (dev tool). Run against a local gantry DB:
//   BOONDI_CRM_DATABASE_URL=... npm run smoke
// Verifies the upsert merge end-to-end: a query promotes to a lead in the SAME
// row (no duplicate), and the Blueprint score comes out 77 (P2). Self-cleaning
// (deletes its own fake-number row). Not part of the build or the vitest suite.
import { createPool } from '../src/db/pool.js';
import { RecordsRepository } from '../src/db/records-repository.js';

const PHONE = '9990000001'; // clearly-fake smoke number
const pool = createPool(
  process.env.BOONDI_CRM_DATABASE_URL ?? process.env.GANTRY_DATABASE_URL!,
  process.env.BOONDI_CRM_DB_SCHEMA ?? 'gantry',
);
const repo = new RecordsRepository(pool);

try {
  await pool.query('DELETE FROM boondi_business_records WHERE phone=$1', [PHONE]);

  const q = await repo.recordQuery(PHONE, {
    intentCategory: 'gifting_b2b',
    summaryBrief: 'Office Diwali boxes — casual interest',
    triggerExcerpt: 'thinking of boxes for my office',
  });
  console.log('QUERY  ->', { id: q.id, status: q.status, score: q.score, band: q.band });

  const l = await repo.upgradeToLead(PHONE, {
    quantity: 300,
    budgetPerGiftInr: 1500,
    buyerType: 'employee_gifting',
    customisation: 'logo',
    locationScope: 'multi_city',
    timelineDays: 10,
    contactQuality: 'corporate_email',
    occasion: 'Diwali',
    locations: 'Mumbai + Delhi',
    timeline: 'in 10 days',
  });
  console.log('LEAD   ->', {
    id: l.id,
    status: l.status,
    score: l.score,
    band: l.band,
    sameRow: l.id === q.id,
  });

  const open = await repo.getOpenRecordByPhone(PHONE);
  const count = await pool.query(
    'SELECT count(*)::int AS n FROM boondi_business_records WHERE phone=$1',
    [PHONE],
  );
  console.log('OPEN   ->', { status: open?.status, score: open?.score, band: open?.band });
  console.log('ROWS   ->', count.rows[0].n);

  const ok =
    q.status === 'query' &&
    q.score === null &&
    l.status === 'lead' &&
    l.score === 77 &&
    l.band === 'P2' &&
    l.id === q.id &&
    count.rows[0].n === 1;
  console.log(ok ? 'SMOKE PASS ✅' : 'SMOKE FAIL ❌');

  await pool.query('DELETE FROM boondi_business_records WHERE phone=$1', [PHONE]);
  process.exitCode = ok ? 0 : 1;
} finally {
  await pool.end();
}
