import { describe, expect, it } from 'vitest';

import { RecordsRepository } from '../src/db/records-repository.js';
import { makeFakePool } from './helpers/fakes.js';

describe('RecordsRepository response comments', () => {
  it('upserts one admin comment for an outbound Boondi message', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = makeFakePool((sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM gantry.messages')) {
        return { rows: [{ id: 'msg_out_1' }] };
      }
      if (sql.includes('RETURNING')) {
        return {
          rows: [
            {
              message_id: 'msg_out_1',
              conversation_id: 'conversation:wa:919900000001',
              comment_text: 'Explain pricing before suggesting the hamper.',
              author_email: 'admin@boondi.local',
              created_at: '2026-06-12T01:00:00.000Z',
              updated_at: '2026-06-12T01:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const repo = new RecordsRepository(pool);
    const saved = await repo.upsertResponseComment({
      gantrySchema: 'gantry',
      messageId: 'msg_out_1',
      conversationId: 'conversation:wa:919900000001',
      commentText: 'Explain pricing before suggesting the hamper.',
      authorEmail: 'admin@boondi.local',
    });

    expect(saved).toEqual({
      messageId: 'msg_out_1',
      conversationId: 'conversation:wa:919900000001',
      commentText: 'Explain pricing before suggesting the hamper.',
      authorEmail: 'admin@boondi.local',
      createdAt: '2026-06-12T01:00:00.000Z',
      updatedAt: '2026-06-12T01:00:00.000Z',
    });
    expect(calls.some((call) => call.sql.includes('ON CONFLICT (message_id)'))).toBe(
      true,
    );
  });

  it('rejects comments for missing or non-outbound messages before writing', async () => {
    const calls: string[] = [];
    const { pool } = makeFakePool((sql) => {
      calls.push(sql);
      if (sql.includes('FROM gantry.messages')) return { rows: [] };
      return { rows: [] };
    });

    const repo = new RecordsRepository(pool);
    await expect(
      repo.upsertResponseComment({
        gantrySchema: 'gantry',
        messageId: 'msg_in_1',
        conversationId: 'conversation:wa:919900000001',
        commentText: 'This should not save.',
        authorEmail: 'admin@boondi.local',
      }),
    ).rejects.toThrow(/outbound message/i);

    expect(calls.some((sql) => sql.includes('boondi_response_comments'))).toBe(
      false,
    );
  });

  it('deletes an existing admin comment after validating the outbound target', async () => {
    const calls: string[] = [];
    const { pool } = makeFakePool((sql) => {
      calls.push(sql);
      if (sql.includes('FROM gantry.messages')) {
        return { rows: [{ id: 'msg_out_1' }] };
      }
      return { rows: [] };
    });

    const repo = new RecordsRepository(pool);
    await repo.deleteResponseComment({
      gantrySchema: 'gantry',
      messageId: 'msg_out_1',
      conversationId: 'conversation:wa:919900000001',
    });

    expect(calls.some((sql) => sql.includes('DELETE FROM boondi_response_comments'))).toBe(
      true,
    );
  });
});
