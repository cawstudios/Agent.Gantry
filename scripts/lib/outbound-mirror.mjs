// Under DRYRUN=1, Gantry skips outbound persistence (channel-wiring.ts:341-347) and core
// changes are off-limits, so the dashboard would show only the customer side. This mirrors
// the REAL captured reply into gantry.messages under the persona conversation, cloning the
// envelope (app_id/provider/provider_connection_id) from an existing inbound row so all FKs
// hold. external_message_id stays NULL so the redelivery unique index never applies.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
const { Client } = pg;

export async function mirrorOutbound({ connectionString, schema = 'gantry', phone, reply, createdAt }) {
  if (!reply || !reply.trim()) return null;
  const conversationId = `conversation:wa:${phone}`;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`set search_path to ${schema}`);
    const { rows } = await client.query(
      `select app_id, provider, provider_connection_id, external_ref_json
         from messages where conversation_id = $1 order by created_at asc limit 1`,
      [conversationId],
    );
    if (!rows.length) {
      throw new Error(`no inbound row to clone for ${conversationId}; cannot mirror outbound`);
    }
    const env = rows[0];
    const id = `outbound:mirror:${randomUUID()}`;
    const ts = createdAt || new Date().toISOString();
    await client.query(
      `insert into messages
         (id, app_id, provider, provider_connection_id, conversation_id, direction,
          sender_user_id, sender_display_name, trust, created_at, received_at, delivery_status, delivered_at, external_ref_json)
       values ($1,$2,$3,$4,$5,'outbound', null,'Boondi','system',$6,$6,'sent',$6,$7)`,
      [id, env.app_id, env.provider, env.provider_connection_id, conversationId, ts, env.external_ref_json],
    );
    await client.query(
      `insert into message_parts (message_id, ordinal, kind, payload_json) values ($1,0,'text',$2)`,
      [id, JSON.stringify({ kind: 'text', text: reply })],
    );
    return id;
  } finally {
    await client.end();
  }
}
