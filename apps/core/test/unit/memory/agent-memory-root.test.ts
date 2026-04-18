import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentMemoryRootService } from '@core/memory/agent-memory-root.js';

const tempRoots: string[] = [];

afterEach(() => {
  AgentMemoryRootService.resetForTests();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('AgentMemoryRootService', () => {
  it('creates the required memory layout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-root-'));
    tempRoots.push(root);

    const service = new AgentMemoryRootService(root);
    const layout = service.getLayout();

    expect(fs.existsSync(layout.profileDir)).toBe(true);
    expect(fs.existsSync(layout.journalDir)).toBe(true);
    expect(fs.existsSync(layout.sessionsDir)).toBe(true);
    expect(fs.existsSync(layout.proceduresDir)).toBe(true);
    expect(fs.existsSync(layout.knowledgeDir)).toBe(true);
    expect(fs.existsSync(layout.rawDir)).toBe(true);
  });

  it('throws with a clear error when AGENT_MEMORY_ROOT is missing', () => {
    expect(() => new AgentMemoryRootService('')).toThrow(
      /AGENT_MEMORY_ROOT is required/,
    );
  });

  it('writes session summaries only under sessions/YYYY/MM/YYYY-MM-DD', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-root-'));
    tempRoots.push(root);

    const service = new AgentMemoryRootService(root);
    const filePath = service.writeSessionSummary({
      groupFolder: 'team-alpha',
      sessionId: 'session-123',
      cause: 'new-session',
      title: 'Session summary',
      markdown: '# Session summary',
      timestamp: new Date('2026-04-10T11:22:33.000Z'),
    });

    expect(filePath).toContain(
      path.join('sessions', '2026', '04', '2026-04-10'),
    );
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('deletes mirrored memory/procedure markdown files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-root-'));
    tempRoots.push(root);

    const service = new AgentMemoryRootService(root);
    const itemPath = service.writeMemoryItem({
      id: 'mem-abc',
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'workflow',
      value: 'Use tests before build.',
      source: 'agent',
      confidence: 0.8,
      is_pinned: false,
      version: 1,
      last_used_at: null,
      last_retrieved_at: null,
      retrieval_count: 0,
      total_score: 0,
      max_score: 0,
      query_hashes_json: '[]',
      recall_days_json: '[]',
      embedding_json: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const procedurePath = service.writeProcedure({
      id: 'proc-abc',
      scope: 'group',
      group_folder: 'team',
      title: 'Deploy',
      body: '1. Build\n2. Deploy',
      tags: [],
      source: 'explicit',
      confidence: 0.8,
      version: 1,
      last_used_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    expect(fs.existsSync(itemPath)).toBe(true);
    expect(fs.existsSync(procedurePath)).toBe(true);

    service.deleteMemoryItem('mem-abc');
    service.deleteProcedure('proc-abc');

    expect(fs.existsSync(itemPath)).toBe(false);
    expect(fs.existsSync(procedurePath)).toBe(false);
  });

  it('returns latest recap for group by parsing summary and open loops sections', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-root-'));
    tempRoots.push(root);

    const service = new AgentMemoryRootService(root);
    service.writeSessionSummary({
      groupFolder: 'team-a',
      sessionId: 's1',
      cause: 'new-session',
      title: 'older',
      markdown: [
        '## Summary',
        'Older summary.',
        '',
        '## Open loops',
        '- old loop',
      ].join('\n'),
      timestamp: new Date('2026-04-10T11:00:00.000Z'),
    });
    service.writeSessionSummary({
      groupFolder: 'team-a',
      sessionId: 's2',
      cause: 'new-session',
      title: 'newer',
      markdown: [
        '## Summary',
        'New summary.',
        '',
        '## Open loops',
        '- new loop',
      ].join('\n'),
      timestamp: new Date('2026-04-10T11:30:00.000Z'),
    });

    const recap = service.getLatestSessionRecap('team-a');
    expect(recap).not.toBeNull();
    expect(recap?.summary).toContain('New summary.');
    expect(recap?.openLoops).toContain('new loop');
  });
});
