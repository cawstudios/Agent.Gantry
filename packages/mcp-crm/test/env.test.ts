import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';

// Minimal valid source: own DB URL + identity secret (required-mode default).
const base = {
  BOONDI_CRM_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  MCP_IDENTITY_SECRET: 'test-secret',
} as NodeJS.ProcessEnv;

function withSettings(settingsYaml: string): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'boondi-crm-env-'));
  fs.writeFileSync(path.join(home, 'settings.yaml'), settingsYaml);
  return { ...base, GANTRY_HOME: home } as NodeJS.ProcessEnv;
}

const settingsWithWatcher = `mcp_servers:
  "mcp:boondi-crm":
    name: boondi-crm
    transport: http
    url: http://127.0.0.1:8082/mcp
    risk_class: medium
    allowed_tool_patterns: ["record_*"]
    auto_approve_tool_patterns: ["record_*"]
    crm_lead_query_extraction_watcher:
      enabled: true
      poll_interval_ms: 30000
      model: sonnet
`;

describe('loadEnv — schema separation', () => {
  it('requires BOONDI_CRM_DATABASE_URL (no GANTRY_DATABASE_URL fallback)', () => {
    const { BOONDI_CRM_DATABASE_URL: _omit, ...noUrl } = base;
    expect(() =>
      loadEnv({ ...noUrl, GANTRY_DATABASE_URL: 'postgres://gantry' }),
    ).toThrow(/BOONDI_CRM_DATABASE_URL/);
  });

  it('defaults its own schema to boondi_crm', () => {
    expect(loadEnv(withSettings(settingsWithWatcher)).dbSchema).toBe(
      'boondi_crm',
    );
  });

  it('rejects an unsafe own-schema name', () => {
    expect(() =>
      loadEnv({ ...base, BOONDI_CRM_DB_SCHEMA: 'bad;name' }),
    ).toThrow(/schema/i);
  });

  it('defaults the gantry read-schema to gantry and honors the override', () => {
    expect(loadEnv(withSettings(settingsWithWatcher)).gantrySchema).toBe(
      'gantry',
    );
    expect(
      loadEnv({
        ...withSettings(settingsWithWatcher),
        BOONDI_CRM_GANTRY_SCHEMA: 'gantry_v2',
      }).gantrySchema,
    ).toBe('gantry_v2');
  });
});

describe('loadEnv watcher config', () => {
  it('loads watcher model and interval from YAML-owned config projection', () => {
    expect(
      loadEnv(withSettings(settingsWithWatcher)).crmLeadQueryExtractionWatcher,
    ).toEqual({
      enabled: true,
      pollIntervalMs: 30000,
      model: 'sonnet',
      maxParallelExtractions: 2,
      batchSize: 25,
      dbPoolSize: 5,
    });
  });

  it('keeps watcher model and interval when disabled for manual extraction', () => {
    const settingsWithDisabledWatcher = `mcp_servers:
  "mcp:boondi-crm":
    name: boondi-crm
    transport: http
    url: http://127.0.0.1:8082/mcp
    risk_class: medium
    allowed_tool_patterns: ["record_*"]
    auto_approve_tool_patterns: ["record_*"]
    crm_lead_query_extraction_watcher:
      enabled: false
      poll_interval_ms: 30000
      model: haiku
`;

    expect(
      loadEnv(withSettings(settingsWithDisabledWatcher))
        .crmLeadQueryExtractionWatcher,
    ).toEqual({
      enabled: false,
      pollIntervalMs: 30000,
      model: 'haiku',
      maxParallelExtractions: 2,
      batchSize: 25,
      dbPoolSize: 5,
    });
  });

  it('fails closed when watcher config is missing from settings.yaml', () => {
    expect(() =>
      loadEnv(withSettings('mcp_servers:\n  "mcp:boondi-crm":\n    name: boondi-crm\n')),
    ).toThrow(
      'mcp_servers.mcp:boondi-crm.crm_lead_query_extraction_watcher is required',
    );
  });

  it('reports missing watcher YAML model as a settings field', () => {
    const settingsMissingModel = `mcp_servers:
  "mcp:boondi-crm":
    name: boondi-crm
    transport: http
    url: http://127.0.0.1:8082/mcp
    risk_class: medium
    allowed_tool_patterns: ["record_*"]
    auto_approve_tool_patterns: ["record_*"]
    crm_lead_query_extraction_watcher:
      enabled: true
      poll_interval_ms: 30000
`;

    expect(() => loadEnv(withSettings(settingsMissingModel))).toThrow(
      'Missing required settings.yaml field: mcp_servers.mcp:boondi-crm.crm_lead_query_extraction_watcher.model',
    );
  });
});

describe('loadEnv — background-isolation knobs', () => {
  const withKnobs = (extraLines: string) =>
    withSettings(`mcp_servers:
  "mcp:boondi-crm":
    name: boondi-crm
    transport: http
    url: http://127.0.0.1:8082/mcp
    risk_class: medium
    allowed_tool_patterns: ["record_*"]
    auto_approve_tool_patterns: ["record_*"]
    crm_lead_query_extraction_watcher:
      enabled: true
      poll_interval_ms: 30000
      model: haiku
${extraLines}
`);

  it('parses explicit max_parallel_extractions, batch_size, db_pool_size', () => {
    const w = loadEnv(
      withKnobs(
        '      max_parallel_extractions: 3\n      batch_size: 40\n      db_pool_size: 6',
      ),
    ).crmLeadQueryExtractionWatcher;
    expect(w.maxParallelExtractions).toBe(3);
    expect(w.batchSize).toBe(40);
    expect(w.dbPoolSize).toBe(6);
  });

  it('defaults the knobs when absent (2 / 25 / 5)', () => {
    const w = loadEnv(withKnobs('')).crmLeadQueryExtractionWatcher;
    expect(w.maxParallelExtractions).toBe(2);
    expect(w.batchSize).toBe(25);
    expect(w.dbPoolSize).toBe(5);
  });

  it('rejects db_pool_size smaller than max_parallel_extractions + 1 (deadlock guard)', () => {
    expect(() =>
      loadEnv(
        withKnobs('      max_parallel_extractions: 5\n      db_pool_size: 5'),
      ),
    ).toThrow(
      /db_pool_size \(5\) must be >= max_parallel_extractions \+ 1 \(6\)/,
    );
  });

  it('rejects an unsupported watcher key', () => {
    expect(() => loadEnv(withKnobs('      parallelism: 3'))).toThrow(
      /crm_lead_query_extraction_watcher\.parallelism is not supported/,
    );
  });
});
