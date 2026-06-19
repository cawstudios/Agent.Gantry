import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { deriveContactQuality, scoreLead } from '../scoring.js';
import {
  type BusinessRecord,
  type BusinessStatus,
  type RecordInput,
  type ResponseComment,
} from './types.js';

// All read/write access to boondi_business_records. The merge logic
// (query -> qualifying -> lead, never downgrading) lives here in plain TS for
// readability rather than gnarly ON CONFLICT SQL. phone is the customer key and
// is supplied by the caller from the VERIFIED identity — never from tool args.

const COLUMNS = `
  id, phone, customer_name, conversation_id, status, intent_category,
  occasion, quantity, quantity_raw, budget_per_gift_inr, budget_total_inr,
  budget_raw, locations, location_scope, timeline, timeline_days, buyer_type,
  customisation, contact_quality, score, band, summary_brief, trigger_excerpt,
  source, confidence, needs_review, created_at, updated_at
`;

type Row = Record<string, unknown>;

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/i;

export class ResponseCommentTargetError extends Error {
  constructor() {
    super('Response comment target must be an existing outbound message.');
    this.name = 'ResponseCommentTargetError';
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToRecord(row: Row): BusinessRecord {
  return {
    id: row.id as string,
    phone: row.phone as string,
    customerName: (row.customer_name as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null,
    status: row.status as BusinessStatus,
    intentCategory: row.intent_category as BusinessRecord['intentCategory'],
    occasion: (row.occasion as string | null) ?? null,
    quantity: (row.quantity as number | null) ?? null,
    quantityRaw: (row.quantity_raw as string | null) ?? null,
    budgetPerGiftInr: (row.budget_per_gift_inr as number | null) ?? null,
    budgetTotalInr: (row.budget_total_inr as number | null) ?? null,
    budgetRaw: (row.budget_raw as string | null) ?? null,
    locations: (row.locations as string | null) ?? null,
    locationScope:
      (row.location_scope as BusinessRecord['locationScope']) ?? null,
    timeline: (row.timeline as string | null) ?? null,
    timelineDays: (row.timeline_days as number | null) ?? null,
    buyerType: (row.buyer_type as BusinessRecord['buyerType']) ?? null,
    customisation:
      (row.customisation as BusinessRecord['customisation']) ?? null,
    contactQuality:
      (row.contact_quality as BusinessRecord['contactQuality']) ?? null,
    score: (row.score as number | null) ?? null,
    band: (row.band as BusinessRecord['band']) ?? null,
    confidence: (row.confidence as number | null) ?? null,
    needsReview: (row.needs_review as boolean | null) ?? false,
    summaryBrief: (row.summary_brief as string | null) ?? null,
    triggerExcerpt: (row.trigger_excerpt as string | null) ?? null,
    source: row.source as string,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToResponseComment(row: Row): ResponseComment {
  return {
    messageId: row.message_id as string,
    conversationId: row.conversation_id as string,
    commentText: row.comment_text as string,
    authorEmail: row.author_email as string,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function safeSchemaName(schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new Error(`Unsafe schema name: ${schema}`);
  }
  return schema;
}

const STATUS_RANK: Record<'query' | 'qualifying' | 'lead', number> = {
  query: 1,
  qualifying: 2,
  lead: 3,
};

function pick<T>(next: T | undefined, prev: T | null | undefined): T | null {
  if (next !== undefined && next !== null) return next;
  return prev ?? null;
}

function hasAnyQualificationField(r: {
  occasion: string | null;
  quantity: number | null;
  budgetPerGiftInr: number | null;
  budgetTotalInr: number | null;
  locationScope: BusinessRecord['locationScope'];
  timelineDays: number | null;
  buyerType: BusinessRecord['buyerType'];
  customisation: BusinessRecord['customisation'];
}): boolean {
  return (
    r.occasion != null ||
    r.quantity != null ||
    r.budgetPerGiftInr != null ||
    r.budgetTotalInr != null ||
    r.locationScope != null ||
    r.timelineDays != null ||
    r.buyerType != null ||
    r.customisation != null
  );
}

export class RecordsRepository {
  constructor(private readonly pool: Pool) {}

  private async assertOutboundMessageTarget(
    client: Pick<PoolClient, 'query'>,
    params: {
      gantrySchema: string;
      messageId: string;
      conversationId: string;
    },
  ): Promise<void> {
    const gantrySchema = safeSchemaName(params.gantrySchema);
    const res = await client.query(
      `SELECT m.id
       FROM ${gantrySchema}.messages m
       WHERE m.id = $1
         AND m.conversation_id = $2
         AND m.direction = 'outbound'
       LIMIT 1`,
      [params.messageId, params.conversationId],
    );
    if (!res.rows[0]) throw new ResponseCommentTargetError();
  }

  async upsertResponseComment(params: {
    gantrySchema: string;
    messageId: string;
    conversationId: string;
    commentText: string;
    authorEmail: string;
  }): Promise<ResponseComment> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertOutboundMessageTarget(client, params);
      const res = await client.query(
        `INSERT INTO boondi_response_comments (
           message_id, conversation_id, comment_text, author_email
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (message_id) DO UPDATE SET
           conversation_id = EXCLUDED.conversation_id,
           comment_text = EXCLUDED.comment_text,
           author_email = EXCLUDED.author_email,
           updated_at = now()
         RETURNING
           message_id, conversation_id, comment_text, author_email,
           created_at, updated_at`,
        [
          params.messageId,
          params.conversationId,
          params.commentText,
          params.authorEmail,
        ],
      );
      await client.query('COMMIT');
      return rowToResponseComment(res.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteResponseComment(params: {
    gantrySchema: string;
    messageId: string;
    conversationId: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertOutboundMessageTarget(client, params);
      await client.query(
        `DELETE FROM boondi_response_comments
         WHERE message_id = $1 AND conversation_id = $2`,
        [params.messageId, params.conversationId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listAll(): Promise<BusinessRecord[]> {
    const res = await this.pool.query(
      `SELECT ${COLUMNS} FROM boondi_business_records
       ORDER BY (status = 'lead') DESC, score DESC NULLS LAST, updated_at DESC`,
    );
    return res.rows.map(rowToRecord);
  }

  private merge(
    phone: string,
    existing: BusinessRecord | null,
    input: RecordInput,
    opts: { targetLead: boolean; source: 'agent' | 'reconciler' | 'extractor' },
  ): BusinessRecord {
    const quantity = pick(input.quantity, existing?.quantity);
    let budgetPerGiftInr = pick(
      input.budgetPerGiftInr,
      existing?.budgetPerGiftInr,
    );
    const budgetTotalInr = pick(input.budgetTotalInr, existing?.budgetTotalInr);
    // Derive per-gift from total/quantity when only a total was shared.
    if (budgetPerGiftInr == null && budgetTotalInr != null && quantity) {
      budgetPerGiftInr = Math.round(budgetTotalInr / quantity);
    }

    const base = {
      occasion: pick(input.occasion, existing?.occasion),
      quantity,
      quantityRaw: pick(input.quantityRaw, existing?.quantityRaw),
      budgetPerGiftInr,
      budgetTotalInr,
      budgetRaw: pick(input.budgetRaw, existing?.budgetRaw),
      locations: pick(input.locations, existing?.locations),
      locationScope: pick(input.locationScope, existing?.locationScope),
      timeline: pick(input.timeline, existing?.timeline),
      timelineDays: pick(input.timelineDays, existing?.timelineDays),
      buyerType: pick(input.buyerType, existing?.buyerType),
      customisation: pick(input.customisation, existing?.customisation),
      // Prefer an explicit/existing enum; otherwise derive deterministically from
      // the raw email/phone the agent passed (the agent classifies the enum
      // unreliably but extracts raw contact details well).
      contactQuality:
        pick(input.contactQuality, existing?.contactQuality) ??
        deriveContactQuality(input.contactEmail, input.contactPhone) ??
        null,
    };

    // Status ladder: leads stay leads; otherwise qualifying once any field is
    // known, else query. Explicit lead target always wins.
    let status: BusinessStatus;
    if (opts.targetLead || existing?.status === 'lead') {
      status = 'lead';
    } else {
      status = hasAnyQualificationField(base) ? 'qualifying' : 'query';
    }
    // Never downgrade below an existing open rank.
    if (
      existing &&
      STATUS_RANK[existing.status as 'query' | 'qualifying' | 'lead'] >
        STATUS_RANK[status as 'query' | 'qualifying' | 'lead']
    ) {
      status = existing.status;
    }

    // Score only leads (No Lead Left Behind: queries are captured regardless).
    let score: number | null = existing?.score ?? null;
    let band = existing?.band ?? null;
    if (status === 'lead') {
      const result = scoreLead({
        quantity: base.quantity ?? undefined,
        budgetPerGiftInr: base.budgetPerGiftInr ?? undefined,
        budgetUndecided: input.budgetUndecided,
        buyerType: base.buyerType ?? undefined,
        customisation: base.customisation ?? undefined,
        locationScope: base.locationScope ?? undefined,
        timelineDays: base.timelineDays ?? undefined,
        timelineExploring: input.timelineExploring,
        contactQuality: base.contactQuality ?? undefined,
      });
      score = result.score;
      band = result.band;
    }

    return {
      id: existing?.id ?? `bcr_${crypto.randomUUID()}`,
      phone,
      customerName: pick(input.customerName, existing?.customerName),
      // Derive the canonical Gantry conversation id from the verified phone so
      // the dashboard can link a record straight back to its chat. Matches
      // gantry.conversations.id ("conversation:wa:<phone>"). The agent never
      // needs to pass it; an explicit value (or existing) still wins.
      conversationId:
        pick(input.conversationId, existing?.conversationId) ??
        `conversation:wa:${phone}`,
      status,
      intentCategory:
        pick(input.intentCategory, existing?.intentCategory) ?? 'other',
      ...base,
      score,
      band,
      confidence: pick(input.confidence, existing?.confidence),
      needsReview: input.needsReview ?? existing?.needsReview ?? false,
      summaryBrief: pick(input.summaryBrief, existing?.summaryBrief),
      triggerExcerpt: pick(input.triggerExcerpt, existing?.triggerExcerpt),
      source: existing?.source ?? opts.source,
      createdAt: existing?.createdAt ?? '',
      updatedAt: '',
    };
  }

  private async insertRow(
    client: PoolClient,
    r: BusinessRecord,
  ): Promise<BusinessRecord> {
    const res = await client.query(
      `INSERT INTO boondi_business_records (
         id, phone, customer_name, conversation_id, status, intent_category,
         occasion, quantity, quantity_raw, budget_per_gift_inr, budget_total_inr,
         budget_raw, locations, location_scope, timeline, timeline_days,
         buyer_type, customisation, contact_quality, score, band, summary_brief,
         trigger_excerpt, source, confidence, needs_review
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
         $21,$22,$23,$24,$25,$26
       )
       RETURNING ${COLUMNS}`,
      this.values(r),
    );
    return rowToRecord(res.rows[0]);
  }

  private async updateRow(
    client: PoolClient,
    id: string,
    r: BusinessRecord,
  ): Promise<BusinessRecord> {
    const res = await client.query(
      `UPDATE boondi_business_records SET
         phone=$2, customer_name=$3, conversation_id=$4, status=$5,
         intent_category=$6, occasion=$7, quantity=$8, quantity_raw=$9,
         budget_per_gift_inr=$10, budget_total_inr=$11, budget_raw=$12,
         locations=$13, location_scope=$14, timeline=$15, timeline_days=$16,
         buyer_type=$17, customisation=$18, contact_quality=$19, score=$20,
         band=$21, summary_brief=$22, trigger_excerpt=$23, source=$24,
         confidence=$25, needs_review=$26,
         updated_at=now()
       WHERE id=$1
       RETURNING ${COLUMNS}`,
      [id, ...this.values(r).slice(1)],
    );
    return rowToRecord(res.rows[0]);
  }

  // All OPEN opportunities for a phone (a customer may have several).
  async getOpenOpportunitiesByPhone(phone: string): Promise<BusinessRecord[]> {
    const res = await this.pool.query(
      `SELECT ${COLUMNS} FROM boondi_business_records
        WHERE phone = $1 AND status IN ('query','qualifying','lead')
        ORDER BY updated_at DESC`,
      [phone],
    );
    return res.rows.map(rowToRecord);
  }

  // Newest OPEN opportunity for a compact returning-customer greeting.
  async getLastOpenOpportunityByPhone(
    phone: string,
  ): Promise<BusinessRecord | null> {
    const res = await this.pool.query(
      `SELECT ${COLUMNS} FROM boondi_business_records
        WHERE phone = $1 AND status IN ('query','qualifying','lead')
        ORDER BY updated_at DESC
        LIMIT 1`,
      [phone],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  }

  // Extractor write primitive: update the matched opportunity, else insert new.
  async upsertOpportunity(params: {
    match: string | null;
    phone: string;
    conversationId: string;
    input: RecordInput;
    targetLead: boolean;
    source: 'agent' | 'reconciler' | 'extractor';
    confidence?: number;
    needsReview?: boolean;
  }): Promise<BusinessRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let existing: BusinessRecord | null = null;
      if (params.match) {
        const res = await client.query(
          `SELECT ${COLUMNS} FROM boondi_business_records
            WHERE id = $1 AND phone = $2
              AND status IN ('query','qualifying','lead') FOR UPDATE`,
          [params.match, params.phone],
        );
        existing = res.rows[0] ? rowToRecord(res.rows[0]) : null;
      }
      const input: RecordInput = {
        ...params.input,
        conversationId: params.conversationId,
        confidence: params.confidence,
        needsReview: params.needsReview,
      };
      const merged = this.merge(params.phone, existing, input, {
        targetLead: params.targetLead,
        source: params.source,
      });
      const saved = existing
        ? await this.updateRow(client, existing.id, merged)
        : await this.insertRow(client, merged);
      await client.query('COMMIT');
      return saved;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // Column order matches the INSERT/UPDATE statements above.
  private values(r: BusinessRecord): unknown[] {
    return [
      r.id,
      r.phone,
      r.customerName,
      r.conversationId,
      r.status,
      r.intentCategory,
      r.occasion,
      r.quantity,
      r.quantityRaw,
      r.budgetPerGiftInr,
      r.budgetTotalInr,
      r.budgetRaw,
      r.locations,
      r.locationScope,
      r.timeline,
      r.timelineDays,
      r.buyerType,
      r.customisation,
      r.contactQuality,
      r.score,
      r.band,
      r.summaryBrief,
      r.triggerExcerpt,
      r.source,
      r.confidence,
      r.needsReview,
    ];
  }
}
