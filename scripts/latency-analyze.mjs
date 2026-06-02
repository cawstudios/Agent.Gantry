#!/usr/bin/env node
// MEASUREMENT-ONLY: fuse the Gantry flow log with the runner timing probe to
// break down per-message latency. Reads GANTRY_DEV_LOG (default /tmp/gantry-dev.log)
// and GANTRY_TIMING_LOG (default /tmp/gantry-timing.jsonl).
//
// Boot overhead (savable by a warm pool) = first_sdk_message - spawn.
// Everything after first_sdk_message (inference + tool round-trips) is paid by
// warm runs too.
import fs from 'node:fs';

const DEV_LOG = process.env.GANTRY_DEV_LOG || '/tmp/gantry-dev.log';
const TIMING_LOG = process.env.GANTRY_TIMING_LOG || '/tmp/gantry-timing.jsonl';

const ms = (iso) => Date.parse(iso);
const fmt = (x) => (x == null ? '   -  ' : `${(x / 1000).toFixed(2)}s`);

// ---- parse dev log -------------------------------------------------------
function parseDevLog(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const tsMatch = line.match(/^\[([0-9T:.Z-]+)\]/);
    if (!tsMatch) continue;
    const t = ms(tsMatch[1]);
    const brace = line.indexOf('{');
    let json = {};
    if (brace !== -1) {
      try {
        json = JSON.parse(line.slice(brace));
      } catch {
        json = {};
      }
    }
    if (line.includes('Spawning host agent')) {
      events.push({ t, kind: 'spawn', processName: json.processName, model: json.model });
    } else if (line.includes('Guardrail allowed message')) {
      events.push({ t, kind: 'guardrail_allow' });
    } else if (typeof json.flow === 'string') {
      events.push({
        t,
        kind: `flow:${json.flow}`,
        toolName: json.toolName,
        replyChars: json.replyChars,
        guardrailDecision: json.guardrailDecision,
      });
    }
  }
  return events.sort((a, b) => a.t - b.t);
}

// ---- parse timing probe --------------------------------------------------
function parseTiming(text) {
  const byHandle = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o.handle || !o.mark) continue;
    if (!byHandle.has(o.handle)) byHandle.set(o.handle, {});
    byHandle.get(o.handle)[o.mark] = o.t;
  }
  return byHandle;
}

// ---- segment into runs (by spawn) ---------------------------------------
function segment(events) {
  const runs = [];
  let cur = null;
  for (const e of events) {
    if (e.kind === 'spawn') {
      cur = { spawn: e, processName: e.processName, model: e.model, events: [], guardrailAllow: null };
      runs.push(cur);
    } else if (e.kind === 'guardrail_allow') {
      // belongs to the NEXT spawn; stash on a pending slot
      pendingGuardrail = e;
    } else if (cur) {
      cur.events.push(e);
    }
    if (e.kind === 'spawn' && pendingGuardrail) {
      cur.guardrailAllow = pendingGuardrail;
      pendingGuardrail = null;
    }
  }
  return runs;
}
let pendingGuardrail = null;

function firstOf(run, kind) {
  return run.events.find((e) => e.kind === kind);
}

function analyzeRun(run, timing) {
  const t0 = run.spawn.t;
  const marks = timing.get(run.processName) || {};
  const reqs = run.events.filter((e) => e.kind === 'flow:mcp.request');
  const resps = run.events.filter((e) => e.kind === 'flow:mcp.response');
  const outbound = [...run.events].reverse().find((e) => e.kind === 'flow:outbound');
  const firstTool = reqs[0];
  const firstSdk = marks.first_sdk_message;
  const firstActivity = firstTool
    ? firstTool.t
    : outbound
      ? outbound.t
      : null;

  // inter-tool model round-trips: request[i+1] - response[i]
  let toolDance = 0;
  for (let i = 0; i < reqs.length - 1; i++) {
    if (resps[i]) toolDance += reqs[i + 1].t - resps[i].t;
  }
  const lastResp = resps[resps.length - 1];

  return {
    name: run.processName,
    model: run.model,
    guardrailToSpawn: run.guardrailAllow ? t0 - run.guardrailAllow.t : null,
    nodeLoad: marks.runner_loaded ? marks.runner_loaded - t0 : null,
    setup: marks.runner_loaded && marks.before_sdk_query ? marks.before_sdk_query - marks.runner_loaded : null,
    cliMcp: marks.before_sdk_query && firstSdk ? firstSdk - marks.before_sdk_query : null,
    bootTotal: firstSdk ? firstSdk - t0 : null,
    firstInference: firstSdk && firstActivity ? firstActivity - firstSdk : null,
    toolCount: reqs.length,
    toolDance: reqs.length > 1 ? toolDance : null,
    finalGen: outbound ? (lastResp ? outbound.t - lastResp.t : firstSdk ? outbound.t - firstSdk : null) : null,
    replyChars: outbound?.replyChars,
    totalReply: outbound && run.guardrailAllow ? outbound.t - run.guardrailAllow.t : outbound ? outbound.t - t0 : null,
  };
}

// ---- run -----------------------------------------------------------------
const devText = fs.existsSync(DEV_LOG) ? fs.readFileSync(DEV_LOG, 'utf8') : '';
const timingText = fs.existsSync(TIMING_LOG) ? fs.readFileSync(TIMING_LOG, 'utf8') : '';
const events = parseDevLog(devText);
const timing = parseTiming(timingText);
const runs = segment(events).map((r) => analyzeRun(r, timing));

if (runs.length === 0) {
  console.log('No agent spawns found in', DEV_LOG);
  process.exit(0);
}

console.log(`\nAnalyzed ${runs.length} agent run(s). Timing handles: ${timing.size}\n`);
const H = ['#', 'model', 'g→spawn', 'nodeLoad', 'setup', 'cliMcp', 'BOOT', '1stInfer', 'tools', 'toolDance', 'finalGen', 'TOTAL', 'chars'];
console.log(H.map((h) => h.padStart(9)).join(' '));
runs.forEach((r, i) => {
  const row = [
    String(i + 1),
    (r.model || '').replace('claude-', ''),
    fmt(r.guardrailToSpawn),
    fmt(r.nodeLoad),
    fmt(r.setup),
    fmt(r.cliMcp),
    fmt(r.bootTotal),
    fmt(r.firstInference),
    String(r.toolCount),
    fmt(r.toolDance),
    fmt(r.finalGen),
    fmt(r.totalReply),
    String(r.replyChars ?? '-'),
  ];
  console.log(row.map((c) => c.padStart(9)).join(' '));
});

// aggregate (mean) over runs that actually booted (have BOOT) and used tools
const booted = runs.filter((r) => r.bootTotal != null);
const mean = (sel) => {
  const xs = booted.map(sel).filter((x) => x != null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
console.log('\n— mean over %d booted run(s) —', booted.length);
console.log(`  BOOT overhead (savable by warm pool): ${fmt(mean((r) => r.bootTotal))}`);
console.log(`    ├ node boot + module load: ${fmt(mean((r) => r.nodeLoad))}`);
console.log(`    ├ runner setup:            ${fmt(mean((r) => r.setup))}`);
console.log(`    └ CLI boot + MCP connect:  ${fmt(mean((r) => r.cliMcp))}`);
console.log(`  first inference (to 1st tool/text):  ${fmt(mean((r) => r.firstInference))}`);
console.log(`  tool dance (inter-call model RTs):   ${fmt(mean((r) => r.toolDance))}`);
console.log(`  final answer generation:             ${fmt(mean((r) => r.finalGen))}`);
console.log(`  TOTAL reply (guardrail→outbound):    ${fmt(mean((r) => r.totalReply))}`);
console.log('');
