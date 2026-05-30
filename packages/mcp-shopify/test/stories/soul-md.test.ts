import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOUL_PATH = path.resolve(
  __dirname,
  '../../../../agents/boondi_support/SOUL.md',
);

const REQUIRED_SECTION_HEADERS = [
  /^##\s*1\.\s*Identity/m,
  /^##\s*2\.\s*The Four Tenets/m,
  /^##\s*3\.\s*Personality Gradient/m,
  /^##\s*4\.\s*Voice & Tone Rules/m,
  /^##\s*5\.\s*Target Groups/m,
  /^##\s*6\.\s*Use Cases Scope/m,
  /^##\s*7\.\s*Knowledge Boundaries/m,
  /^##\s*8\.\s*Identity Verification/m,
  /^##\s*9\.\s*Decision Frameworks/m,
  /^##\s*10\.\s*Escalation Logic/m,
  /^##\s*11\.\s*Handoff Standard/m,
  /^##\s*12\.\s*When No Agent Is Available/m,
  /^##\s*13\.\s*Voice Channel Specifics/m,
  /^##\s*14\.\s*Ethics & Limits/m,
  /^##\s*15\.\s*Tools Available/m,
];

const BANNED_PHRASES = [
  'Kindly,',
  'Please be informed',
  'As per your query',
  'We apologise for the inconvenience',
  'Sure, no problem',
  'I am just a bot',
  'I apologise for the inconvenience',
];

describe('SOUL.md persona verification', () => {
  it('exists at agents/boondi_support/SOUL.md (repo root)', async () => {
    const stat = await fs.stat(SOUL_PATH);
    expect(stat.isFile()).toBe(true);
  });

  it('is sized between 8 KB and 25 KB', async () => {
    const stat = await fs.stat(SOUL_PATH);
    expect(stat.size).toBeGreaterThanOrEqual(8 * 1024);
    expect(stat.size).toBeLessThanOrEqual(25 * 1024);
  });

  it('contains all 15 required sections', async () => {
    const content = await fs.readFile(SOUL_PATH, 'utf8');
    for (const re of REQUIRED_SECTION_HEADERS) {
      expect(content).toMatch(re);
    }
  });

  it('contains no banned phrases', async () => {
    const content = await fs.readFile(SOUL_PATH, 'utf8');
    const banList: string[] = [];
    for (const phrase of BANNED_PHRASES) {
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.includes('Banned forever') || line.startsWith('- "')) continue;
        if (line.includes(phrase)) {
          banList.push(`${phrase} -> ${line}`);
        }
      }
    }
    expect(banList).toEqual([]);
  });

  it('contains no HTML tags', async () => {
    const content = await fs.readFile(SOUL_PATH, 'utf8');
    expect(content).not.toMatch(/<\/?(p|div|span|html|body|head|script|style|br|hr|table|tr|td|th)\b[^>]*>/i);
  });
});
