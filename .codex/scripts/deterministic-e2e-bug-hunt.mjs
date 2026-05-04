#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const minFindings = Number(process.env.MYCLAW_BUG_HUNT_MIN_FINDINGS ?? '40');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const specDir = path.join(os.homedir(), '.spec');
const reportPath = path.join(
  specDir,
  `myclaw-deterministic-e2e-bug-hunt-${timestamp}.md`,
);

const postgresUrl =
  process.env.MYCLAW_TEST_DATABASE_URL ??
  'postgresql://myclaw_app:myclaw_app_password@127.0.0.1:5432/myclaw';

const commandPlan = [
  {
    name: 'docker-postgres',
    command: 'docker',
    args: ['compose', '--env-file', '.factory/docker-test.env', 'up', '-d', 'postgres'],
    env: {},
  },
  {
    name: 'e2e',
    command: 'npm',
    args: ['run', 'test:e2e'],
    env: {},
  },
  {
    name: 'integration',
    command: 'npm',
    args: ['run', 'test:integration'],
    env: {},
  },
  {
    name: 'postgres-integration',
    command: 'npm',
    args: ['run', 'test:integration:postgres'],
    env: { MYCLAW_TEST_DATABASE_URL: postgresUrl },
  },
];

function runCommand(step) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(step.command, step.args, {
    cwd: repoRoot,
    env: { ...process.env, ...step.env },
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    name: step.name,
    command: [step.command, ...step.args].join(' '),
    startedAt,
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: trimOutput(result.stdout ?? ''),
    stderr: trimOutput(result.stderr ?? result.error?.message ?? ''),
  };
}

function trimOutput(value) {
  const lines = value.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 80) return lines.join('\n');
  return [...lines.slice(0, 30), '... output truncated ...', ...lines.slice(-50)].join(
    '\n',
  );
}

function walkFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    if (entry.name === '.git' || entry.name === '.factory/postgres-data') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, files);
      continue;
    }
    if (/\.(ts|tsx|js|mjs|md|json)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
}

function relative(filePath) {
  return path.relative(repoRoot, filePath);
}

function staticFindings() {
  const files = [
    ...walkFiles(path.join(repoRoot, 'apps')),
    ...walkFiles(path.join(repoRoot, 'packages')),
    ...walkFiles(path.join(repoRoot, 'docs')),
  ].sort();
  const findings = [];

  const rules = [
    {
      category: 'unfinished-implementation',
      severity: 'high',
      limit: 20,
      test: (line) => /\bTODO\(next-phase\)|not implemented|is not implemented/i.test(line),
      impact:
        'This is active code or product documentation admitting an incomplete implementation path.',
      fix: 'Either finish the capability or turn the gap into an explicit blocked state with a tracked owner.',
    },
    {
      category: 'test-gate-gap',
      severity: 'medium',
      limit: 14,
      test: (line) => /describe\.skip|it\.skip|skipIf\(hasPostgresIntegrationDatabase\)|describe\.skipIf/.test(line),
      impact:
        'A green default run can miss behavior unless the stronger harness path is run with the right environment.',
      fix: 'Keep the skip explicit, but ensure this harness or CI runs the stronger Docker-backed path.',
    },
    {
      category: 'time-dependent-test',
      severity: 'medium',
      limit: 18,
      test: (line, file) =>
        file.includes('/test/') && /setTimeout|\bdelay\(|new Promise\(\(resolve\) => setTimeout/.test(line),
      impact:
        'Time sleeps in tests are common sources of flakes and slow feedback when scheduler timing changes.',
      fix: 'Prefer fake timers, explicit event hooks, or polling helpers with narrow deadlines.',
    },
    {
      category: 'provider-boundary-leak-risk',
      severity: 'medium',
      limit: 18,
      test: (line, file) =>
        file.includes('/src/') &&
        /ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|MYCLAW_MCP_SERVERS_JSON|legacy/.test(
          line,
        ),
      impact:
        'Provider-specific or legacy runtime details in active source can bypass the provider-neutral boundary.',
      fix: 'Move behavior behind provider ports or remove stale fallback paths.',
    },
    {
      category: 'runtime-timer-cleanup-risk',
      severity: 'medium',
      limit: 18,
      test: (line, file) =>
        file.includes('/src/') && /setInterval|setTimeout/.test(line),
      impact:
        'Long-lived timers can keep tests or runtime shutdown alive unless every path owns cleanup.',
      fix: 'Verify each timer is cancelled on shutdown/error and covered by focused tests.',
    },
    {
      category: 'network-timeout-risk',
      severity: 'medium',
      limit: 8,
      test: (line, file) =>
        file.includes('/src/') &&
        (/dns\.lookup|fetch\(/.test(line) || /lookupHostname/.test(line)) &&
        !/timeout|AbortController/.test(line),
      impact:
        'Network or DNS calls without an application-level timeout can hang control or runtime startup.',
      fix: 'Wrap calls in a bounded timeout and test the timeout path.',
    },
  ];

  for (const rule of rules) {
    let count = 0;
    for (const file of files) {
      if (count >= rule.limit) break;
      const rel = relative(file);
      const lines = readLines(file);
      for (let index = 0; index < lines.length; index += 1) {
        if (count >= rule.limit) break;
        const line = lines[index];
        if (!rule.test(line, rel)) continue;
        count += 1;
        findings.push({
          id: `MYCLAW-BH-${String(findings.length + 1).padStart(3, '0')}`,
          category: rule.category,
          severity: rule.severity,
          evidence: `${rel}:${index + 1}`,
          snippet: line.trim().slice(0, 180),
          impact: rule.impact,
          fix: rule.fix,
        });
      }
    }
  }

  return findings.slice(0, Math.max(minFindings, 40));
}

function commandFindings(commandResults) {
  const findings = [];
  for (const result of commandResults) {
    if (result.exitCode === 0) continue;
    findings.push({
      id: `MYCLAW-CMD-${String(findings.length + 1).padStart(3, '0')}`,
      category: 'verification-failure',
      severity: 'high',
      evidence: result.command,
      snippet: result.stderr || result.stdout || `exit ${result.exitCode}`,
      impact: 'A deterministic verification step failed during the bug-hunt cycle.',
      fix: 'Fix the failing command before trusting downstream report findings.',
    });
  }
  return findings;
}

function renderReport(commandResults, findings) {
  const passed = commandResults.filter((result) => result.exitCode === 0).length;
  const failed = commandResults.length - passed;
  const lines = [
    '# MyClaw deterministic e2e bug-hunt report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Repo: ${repoRoot}`,
    `Minimum requested findings: ${minFindings}`,
    `Discrete findings recorded: ${findings.length}`,
    '',
    '## Harness boundary',
    '',
    '- Real Docker Postgres is used when `docker compose` is available.',
    '- LLM providers and channel providers remain mocked through the existing Vitest harnesses.',
    '- No real Slack, Teams, Telegram, Claude, OpenAI, OneCLI, browser, or network-auth credentials are required.',
    '- Runtime homes are isolated by the existing test fixtures; Postgres tests use unique schemas.',
    '',
    '## Command results',
    '',
    `Passed: ${passed}`,
    `Failed: ${failed}`,
    '',
  ];

  for (const result of commandResults) {
    lines.push(
      `### ${result.name}`,
      '',
      `Command: \`${result.command}\``,
      `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ''}`,
      '',
      '```text',
      result.stderr || result.stdout || '(no output)',
      '```',
      '',
    );
  }

  lines.push('## Findings', '');
  for (const finding of findings) {
    lines.push(
      `### ${finding.id} - ${finding.category}`,
      '',
      `Severity: ${finding.severity}`,
      `Evidence: \`${finding.evidence}\``,
      '',
      '```text',
      finding.snippet || '(no snippet)',
      '```',
      '',
      `Impact: ${finding.impact}`,
      '',
      `Fix direction: ${finding.fix}`,
      '',
    );
  }

  return `${lines.join('\n')}\n`;
}

fs.mkdirSync(specDir, { recursive: true });

const commandResults = commandPlan.map(runCommand);
const findings = [...commandFindings(commandResults), ...staticFindings()];
const selectedFindings = findings.slice(0, Math.max(minFindings, 40));

fs.writeFileSync(reportPath, renderReport(commandResults, selectedFindings));

console.log(`Wrote ${selectedFindings.length} findings to ${reportPath}`);
for (const result of commandResults) {
  console.log(`${result.name}: exit ${result.exitCode}`);
}

if (selectedFindings.length < minFindings) {
  console.error(
    `Expected at least ${minFindings} findings, only found ${selectedFindings.length}.`,
  );
  process.exit(1);
}

if (commandResults.some((result) => result.exitCode !== 0)) {
  process.exit(1);
}
