import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(here, '../migrations/0003_response_comments.sql');

function readSql(): string {
  return readFileSync(migrationPath, 'utf8');
}

describe('migration 0003 — response comments', () => {
  it('exists as the next Boondi CRM migration', () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it('creates one editable comment row per response message', () => {
    const sql = readSql();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS boondi_response_comments/);
    expect(sql).toMatch(/message_id\s+text PRIMARY KEY/);
    expect(sql).toMatch(/conversation_id\s+text NOT NULL/);
    expect(sql).toMatch(/comment_text\s+text NOT NULL/);
    expect(sql).toMatch(/author_email\s+text NOT NULL/);
  });

  it('adds a conversation lookup index without referencing Gantry core tables', () => {
    const sql = readSql();
    expect(sql).toMatch(/idx_brc_conversation_updated/);
    expect(sql).not.toMatch(/REFERENCES\s+gantry\./i);
  });
});
