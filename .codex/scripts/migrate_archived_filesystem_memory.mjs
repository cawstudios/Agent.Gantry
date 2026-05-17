#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

function parseArgs(argv) {
  const args = {
    runtimeHome: path.join(process.env.HOME || '', 'gantry'),
    sourceDir: '',
    legacyGroupFolder: 'telegram_main',
    agentId: 'agent:main_agent',
    groupId: 'main_agent',
    channelId: 'conversation:tg:-1003986348737',
    dmUserId: '',
    schema: 'gantry',
    apply: false,
    reportDreamRuns: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (!argv[i]) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === '--runtime-home') args.runtimeHome = next();
    else if (arg === '--source-dir') args.sourceDir = next();
    else if (arg === '--legacy-group-folder') args.legacyGroupFolder = next();
    else if (arg === '--agent-id') args.agentId = next();
    else if (arg === '--group-id') args.groupId = next();
    else if (arg === '--channel-id') args.channelId = next();
    else if (arg === '--dm-user-id') args.dmUserId = next();
    else if (arg === '--schema') args.schema = next();
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--report-dream-runs') args.reportDreamRuns = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.sourceDir && !args.reportDreamRuns) {
    throw new Error('--source-dir is required');
  }
  return args;
}

function readRuntimeEnv(runtimeHome) {
  const envPath = path.join(runtimeHome, '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  if (!env.GANTRY_DATABASE_URL) {
    throw new Error(`GANTRY_DATABASE_URL not found in ${envPath}`);
  }
  return env;
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function subjectHash(input) {
  return `msu_${hashText(
    `${input.appId}:${input.agentId}:${input.subjectType}:${input.subjectId}`,
  ).slice(0, 32)}`;
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontMatter(text, filePath) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error(`Missing front matter: ${filePath}`);
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    meta[line.slice(0, idx).trim()] = stripQuotes(line.slice(idx + 1));
  }
  return { meta, body: text.slice(match[0].length) };
}

function section(body, heading, nextHeading) {
  const start = body.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const contentStart = start + `## ${heading}`.length;
  const end = nextHeading ? body.indexOf(`## ${nextHeading}`, contentStart) : -1;
  return body
    .slice(contentStart, end >= 0 ? end : undefined)
    .trim();
}

function walkMarkdownFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdownFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(fullPath);
  }
  return files.sort();
}

function parseMemoryFiles(args) {
  return walkMarkdownFiles(args.sourceDir)
    .map((filePath) => {
      const text = fs.readFileSync(filePath, 'utf8');
      const { meta, body } = parseFrontMatter(text, filePath);
      return {
        filePath,
        meta,
        value: section(body, 'Value', 'Why'),
        why: section(body, 'Why'),
      };
    })
    .filter(
      (item) =>
        item.meta.scope === 'group' &&
        item.meta.group_folder === args.legacyGroupFolder,
    )
    .map((item) => {
      for (const field of ['id', 'kind', 'key', 'created_at', 'updated_at']) {
        if (!item.meta[field]) {
          throw new Error(`Missing ${field} in ${item.filePath}`);
        }
      }
      if (!item.value) throw new Error(`Missing value in ${item.filePath}`);
      return item;
    });
}

function canonicalRow(args, item) {
  const appId = 'default';
  const subject = {
    appId,
    agentId: args.agentId,
    subjectType: 'channel',
    subjectId: args.channelId,
    groupId: args.groupId,
    channelId: args.channelId,
  };
  const key = item.meta.key;
  const value = item.value;
  const sourceRef = {
    subject,
    source: 'filesystem-memory-migration',
    evidenceIds: [],
    isPinned: item.meta.pinned === 'true',
    version: Number.parseInt(item.meta.version || '1', 10) || 1,
    legacy: {
      id: item.meta.id,
      groupFolder: item.meta.group_folder,
      source: item.meta.source || null,
      loadBearing: item.meta.load_bearing === 'true',
      path: path.relative(args.sourceDir, item.filePath),
    },
  };
  return {
    id: `mem_${hashText(
      `filesystem-memory:${item.meta.id}:${args.agentId}:${args.channelId}:${item.meta.kind}:${key}`,
    ).slice(0, 32)}`,
    app_id: appId,
    agent_id: args.agentId,
    subject_type: 'channel',
    subject_id: subjectHash(subject),
    user_id: null,
    conversation_id: args.channelId,
    thread_id: null,
    kind: item.meta.kind,
    key,
    value_json: JSON.stringify({
      value,
      why: item.why || null,
      contentHash: hashText(
        `${appId}:${args.agentId}:channel:${args.channelId}:${key}:${value}`,
      ),
    }),
    confidence: Number.parseFloat(item.meta.confidence || '1') || 1,
    source_ref_json: JSON.stringify(sourceRef),
    status: 'active',
    last_observed_at: item.meta.updated_at,
    created_at: item.meta.created_at,
    updated_at: item.meta.updated_at,
  };
}

function assertIdentifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  assertIdentifier(args.schema, 'schema');
  const env = readRuntimeEnv(args.runtimeHome);
  const client = new pg.Client({ connectionString: env.GANTRY_DATABASE_URL });
  await client.connect();
  try {
    if (args.reportDreamRuns) {
      const runs = await client.query(
        `select status, phase, subject_type, subject_id, thread_id,
                started_at, completed_at, summary_json
         from ${args.schema}.memory_dream_runs
         order by started_at desc
         limit 20`,
      );
      const decisions = await client.query(
        `select count(*)::int as count from ${args.schema}.memory_dream_decisions`,
      );
      console.log(
        JSON.stringify(
          {
            dreamRunCountShown: runs.rowCount,
            dreamDecisionCount: decisions.rows[0]?.count ?? 0,
            runs: runs.rows,
          },
          null,
          2,
        ),
      );
      return;
    }

    const items = parseMemoryFiles(args);
    const rows = items.map((item) => canonicalRow(args, item));
    const duplicateKeys = rows
      .map((row) => `${row.kind}\0${row.key}`)
      .filter((key, index, all) => all.indexOf(key) !== index);
    if (duplicateKeys.length > 0) {
      throw new Error(
        `Duplicate kind/key entries in source: ${duplicateKeys.length}`,
      );
    }

    const conversation = await client.query(
      `select id, kind from ${args.schema}.conversations where id = $1`,
      [args.channelId],
    );
    if (conversation.rowCount !== 1) {
      throw new Error(`Target conversation not found: ${args.channelId}`);
    }
    if (!['group', 'channel'].includes(conversation.rows[0].kind)) {
      throw new Error(
        `Target conversation ${args.channelId} is ${conversation.rows[0].kind}, not group/channel`,
      );
    }

    const before = await client.query(
      `select kind, key from ${args.schema}.memory_items
       where app_id = 'default'
         and agent_id = $1
         and subject_type = 'channel'
         and subject_id = $2
         and status = 'active'`,
      [args.agentId, rows[0]?.subject_id || subjectHash({
        appId: 'default',
        agentId: args.agentId,
        subjectType: 'channel',
        subjectId: args.channelId,
      })],
    );
    const activeByKind = await client.query(
      `select kind, count(*)::int as count from ${args.schema}.memory_items
       where app_id = 'default'
         and agent_id = $1
         and subject_type = 'channel'
         and subject_id = $2
         and status = 'active'
       group by kind
       order by kind`,
      [args.agentId, rows[0]?.subject_id],
    );
    const sampleKeys = await client.query(
      `select kind, key from ${args.schema}.memory_items
       where app_id = 'default'
         and agent_id = $1
         and subject_type = 'channel'
         and subject_id = $2
         and status = 'active'
       order by kind, key
       limit 8`,
      [args.agentId, rows[0]?.subject_id],
    );
    const dmSubjectId = args.dmUserId
      ? subjectHash({
          appId: 'default',
          agentId: args.agentId,
          subjectType: 'user',
          subjectId: args.dmUserId,
        })
      : '';
    const dmMigratedSourceRows = args.dmUserId
      ? await client.query(
          `select count(*)::int as count from ${args.schema}.memory_items
           where app_id = 'default'
             and agent_id = $1
             and subject_type = 'user'
             and subject_id = $2
             and source_ref_json::jsonb->>'source' = 'filesystem-memory-migration'`,
          [args.agentId, dmSubjectId],
        )
      : { rows: [{ count: null }] };
    const existing = new Set(
      before.rows.map((row) => `${row.kind}\0${row.key}`),
    );
    const toInsert = rows.filter((row) => !existing.has(`${row.kind}\0${row.key}`));

    console.log(
      JSON.stringify(
        {
          mode: args.apply ? 'apply' : 'dry-run',
          sourceItems: rows.length,
          existingActiveTargetItems: before.rowCount,
          wouldInsert: toInsert.length,
          wouldUpdate: rows.length - toInsert.length,
          activeByKind: activeByKind.rows,
          sampleKeys: sampleKeys.rows,
          dmMigratedSourceRows: dmMigratedSourceRows.rows[0].count,
          target: {
            agentId: args.agentId,
            subjectType: 'channel',
            channelId: args.channelId,
            subjectId: rows[0]?.subject_id,
          },
        },
        null,
        2,
      ),
    );

    if (!args.apply) return;

    await client.query('begin');
    for (const row of rows) {
      await client.query(
        `insert into ${args.schema}.memory_items (
          id, app_id, agent_id, subject_type, subject_id, user_id,
          conversation_id, thread_id, kind, key, value_json, confidence,
          source_ref_json, status, last_observed_at, created_at, updated_at
        ) values (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17
        )
        on conflict (
          app_id, agent_id, subject_type, subject_id, coalesce(thread_id, ''), kind, key
        ) where status = 'active'
        do update set
          value_json = excluded.value_json,
          confidence = excluded.confidence,
          source_ref_json = excluded.source_ref_json,
          last_observed_at = excluded.last_observed_at,
          updated_at = excluded.updated_at`,
        [
          row.id,
          row.app_id,
          row.agent_id,
          row.subject_type,
          row.subject_id,
          row.user_id,
          row.conversation_id,
          row.thread_id,
          row.kind,
          row.key,
          row.value_json,
          row.confidence,
          row.source_ref_json,
          row.status,
          row.last_observed_at,
          row.created_at,
          row.updated_at,
        ],
      );
    }
    await client.query('commit');

    const after = await client.query(
      `select kind, count(*)::int as count from ${args.schema}.memory_items
       where app_id = 'default'
         and agent_id = $1
         and subject_type = 'channel'
         and subject_id = $2
         and status = 'active'
       group by kind
       order by kind`,
      [args.agentId, rows[0]?.subject_id],
    );
    console.log(JSON.stringify({ migrated: rows.length, activeByKind: after.rows }, null, 2));
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // Ignore rollback failure; the original error is more useful.
    }
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
