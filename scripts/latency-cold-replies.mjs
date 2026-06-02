#!/usr/bin/env node
// MEASUREMENT-ONLY: per-spawn cold-reply latency, straight from raw log lines.
// reply = first outbound AFTER the last tool response (the real answer, not the
// next /new reset). Fact-based: prints the actual timestamps + segment deltas.
import fs from 'node:fs';

const DEV = process.env.GANTRY_DEV_LOG || '/tmp/gantry-dev.log';
const TIM = process.env.GANTRY_TIMING_LOG || '/tmp/gantry-timing.jsonl';
const S = (x) => (x == null ? '  -  ' : `${(x / 1000).toFixed(2)}s`);

const ev = [];
for (const l of fs.readFileSync(DEV, 'utf8').split('\n')) {
  const m = l.match(/^\[([0-9T:.Z-]+)\]/);
  if (!m) continue;
  const t = Date.parse(m[1]);
  const b = l.indexOf('{');
  let j = {};
  if (b > -1) {
    try {
      j = JSON.parse(l.slice(b));
    } catch {
      j = {};
    }
  }
  if (l.includes('Spawning host agent')) ev.push({ t, k: 'spawn', pn: j.processName });
  else if (typeof j.flow === 'string')
    ev.push({ t, k: j.flow, tool: j.toolName, chars: j.replyChars, deny: (j.result && j.result.isError) || false });
}
ev.sort((a, b) => a.t - b.t);

const runs = [];
let cur = null;
for (const e of ev) {
  if (e.k === 'spawn') {
    cur = { pn: e.pn, t0: e.t, evs: [] };
    runs.push(cur);
  } else if (cur) cur.evs.push(e);
}

const timing = {};
if (fs.existsSync(TIM)) {
  for (const l of fs.readFileSync(TIM, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      (timing[o.handle] = timing[o.handle] || {})[o.mark] = o.t;
    } catch {
      /* skip */
    }
  }
}

const totals = [];
console.log(`\nlabel: ${process.argv[2] || '(run)'}   source: ${DEV}\n`);
runs.forEach((r, i) => {
  const reqs = r.evs.filter((e) => e.k === 'mcp.request');
  const resps = r.evs.filter((e) => e.k === 'mcp.response');
  const denies = resps.filter((e) => e.deny).length;
  const lastResp = resps[resps.length - 1];
  const reply = r.evs.find((e) => e.k === 'outbound' && lastResp && e.t >= lastResp.t)
    || r.evs.find((e) => e.k === 'outbound' && e.chars > 30);
  const fsm = timing[r.pn]?.first_sdk_message;
  const boot = fsm ? fsm - r.t0 : null;
  const firstReq = reqs[0];
  const total = reply ? reply.t - r.t0 : null;
  if (total != null && reply && reply.chars > 30) totals.push(total);
  console.log(
    `run ${i + 1}: spawn->reply=${S(total)}  boot=${S(boot)}  1stInfer=${S(fsm && firstReq ? firstReq.t - fsm : null)}  ` +
      `finalGen=${S(lastResp && reply ? reply.t - lastResp.t : null)}  tools=${reqs.length} denies=${denies} reply=${reply ? reply.chars : '-'}ch`,
  );
});
if (totals.length) {
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  console.log(`\nFACT: cold spawn->reply = [${totals.map((x) => (x / 1000).toFixed(1)).join(', ')}]s  mean=${(mean / 1000).toFixed(1)}s  n=${totals.length}`);
}
