#!/usr/bin/env node
// Drive the Boondi flow through the signed webhook and report what crossed each
// boundary, by reading the GANTRY_FLOW_LOG lines the runtime emits.
//
// Prereqs (see the plan / runbook): both dev servers running in watch mode with
//   GANTRY_FLOW_LOG=1  GANTRY_OUTBOUND_DRYRUN=1  GANTRY_TEST_CALLER_IDENTITY_PHONE=918097288633
//   SHOPIFY_MCP_REQUIRE_VERIFIED_IDENTITY=true
// and the Gantry stdout/stderr tee'd to GANTRY_DEV_LOG (default /tmp/gantry-dev.log).
//
// Usage: node scripts/interakt-test-run.mjs [scenarios.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendWebhook } from './interakt-test-send.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = process.env.GANTRY_DEV_LOG || '/tmp/gantry-dev.log';
const SCENARIOS_PATH = process.argv[2] || path.join(HERE, 'interakt-test-scenarios.json');
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 120_000);
const RESET_WAIT_MS = Number(process.env.RESET_WAIT_MS || 3_000);
// After the first terminal event of a turn, wait briefly for co-emitted events
// to land before snapshotting. The runtime sends the guardrail's canned reply
// (flow:outbound) and only then logs the flow:guardrail decision, and an agent
// turn's flow:llm.output trails its outbound — without this settle the harness
// returns on the first event and drops the rest of the turn's trace.
const SETTLE_MS = Number(process.env.SETTLE_MS || 700);
// Bound for awaiting the /new reset confirmation before a turn. Under parallel
// load the host is busy, so a fixed RESET_WAIT_MS sleep is unreliable — poll for
// the actual reset reply and only then mark the turn offset.
const RESET_WAIT_TIMEOUT_MS = Number(process.env.RESET_WAIT_TIMEOUT_MS || 20_000);
// The canned reply the runtime sends for /new. It must never be mistaken for a
// turn's agent reply when it co-lands in the window under parallel load.
const RESET_REPLY_RE = /Started a fresh session/i;
// A turn's agent session stays warm (intended) after its reply. A FOLLOW-UP turn
// fired before that session goes idle races the still-active session: the follow-up
// is dropped and, worse, stalls the host's group processing for every lane until
// the next /new frees it. So before a follow-up we wait for QUIESCENCE: no new flow
// event for this conversation for QUIESCE_QUIET_MS, meaning the session has finished
// streaming and is idle. Verified: a follow-up ~3s after the reply still raced; ~5s
// was processed — so the quiet window is 6s, with headroom for load. Bounded by
// QUIESCE_MAX_MS. (The first turn after /new needs no quiescence — waitForReset's
// reset reply already signals a fresh, ready session.)
const QUIESCE_QUIET_MS = Number(process.env.QUIESCE_QUIET_MS || 6000);
const QUIESCE_MAX_MS = Number(process.env.QUIESCE_MAX_MS || 60000);
// When a turn's raw llm.output is seen but its customer-visible outbound hasn't
// landed yet (continuation turns emit them in that order), wait up to this grace
// for the outbound before accepting llm.output — so assertions judge the
// post-guard customer reply whenever it is available.
const LLM_OUTBOUND_GRACE_MS = Number(process.env.LLM_OUTBOUND_GRACE_MS || 4000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logSize = () => {
  try {
    return fs.statSync(LOG).size;
  } catch {
    return 0;
  }
};

// Read the logfile slice appended since `fromOffset` (we mark the offset before
// each send so we only parse this turn's lines).
function readSlice(fromOffset) {
  const size = logSize();
  if (size <= fromOffset) return '';
  const fd = fs.openSync(LOG, 'r');
  try {
    const buf = Buffer.alloc(size - fromOffset);
    fs.readSync(fd, buf, 0, buf.length, fromOffset);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Flow events appear in two log shapes: flowLog() lines whose MESSAGE is
// `flow:<event>` (outbound, mcp.*, llm.*), and guardrail decisions logged as a
// human message ("Guardrail handled…") that carry the tag only inside the JSON
// context as `"flow":"guardrail"`. Match the JSON field so BOTH are captured —
// keying off the `flow:` message substring alone silently drops guardrail events.
function parseFlowEvents(text, chatJid) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"flow":')) continue;
    const brace = line.indexOf('{');
    if (brace === -1) continue;
    let obj;
    try {
      obj = JSON.parse(line.slice(brace));
    } catch {
      continue;
    }
    if (!obj || typeof obj.flow !== 'string') continue;
    const eventJid = obj.jid ?? obj.chatJid;
    if (chatJid && eventJid && eventJid !== chatJid) continue;
    events.push(obj);
  }
  return events;
}

async function waitForTurn(fromOffset, chatJid) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  // Snapshot after a short settle so trailing co-emitted events (the guardrail
  // decision after its reply; llm.output after the agent's outbound) are kept.
  const settleAndSnapshot = async () => {
    await sleep(SETTLE_MS);
    return parseFlowEvents(readSlice(fromOffset), chatJid);
  };
  // The customer-visible reply is the post-guard `outbound` (not the canned /new
  // reply). Prefer it as the terminal signal so assertions judge what the customer
  // actually receives. Continuation turns emit `llm.output` (raw, pre-guard) FIRST
  // and the outbound trails by a second or two; so when only llm.output is seen,
  // grace-wait briefly for the outbound before accepting llm.output as fallback.
  const isOutbound = (e) =>
    e.flow === 'outbound' && !RESET_REPLY_RE.test(e.reply || '');
  let firstLlmAt = null;
  while (Date.now() < deadline) {
    const events = parseFlowEvents(readSlice(fromOffset), chatJid);
    // Customer-visible outbound (or a guardrail direct-response) ends the turn.
    if (events.some(isOutbound)) {
      return settleAndSnapshot();
    }
    if (events.some((e) => e.flow === 'guardrail' && e.guardrailDecision)) {
      return settleAndSnapshot();
    }
    // llm.output with no outbound yet: wait up to the grace for the trailing
    // outbound, then accept llm.output so we never hang on a missing outbound.
    if (events.some((e) => e.flow === 'llm.output')) {
      if (firstLlmAt === null) firstLlmAt = Date.now();
      else if (Date.now() - firstLlmAt >= LLM_OUTBOUND_GRACE_MS) {
        return settleAndSnapshot();
      }
    }
    await sleep(1_000);
  }
  return parseFlowEvents(readSlice(fromOffset), chatJid);
}

// After /new, wait specifically for the canned reset reply ("Started a fresh
// session.") for this chatJid — NOT just any outbound. The /new SIGTERMs the warm
// session, which first flushes the previous turn's pending reply and only then
// emits the reset reply; returning on that flushed reply would mark the offset
// before /new finished and the next turn would race the still-resetting session.
async function waitForReset(fromOffset, chatJid) {
  const deadline = Date.now() + RESET_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const events = parseFlowEvents(readSlice(fromOffset), chatJid);
    if (
      events.some(
        (e) => e.flow === 'outbound' && RESET_REPLY_RE.test(e.reply || ''),
      )
    ) {
      return;
    }
    await sleep(250);
  }
}

// Wait until the conversation goes quiet for this chatJid — no NEW flow event
// since fromOffset for QUIESCE_QUIET_MS — so the warm session has finished
// streaming and is idle and ready for the next message. Bounded by QUIESCE_MAX_MS.
// During active processing the session emits events (llm.input, mcp.*, outbound)
// far more often than the quiet window, so this only fires once it truly settles.
async function waitForQuiescence(fromOffset, chatJid) {
  const deadline = Date.now() + QUIESCE_MAX_MS;
  let lastCount = -1;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const n = parseFlowEvents(readSlice(fromOffset), chatJid).length;
    if (n !== lastCount) {
      lastCount = n;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= QUIESCE_QUIET_MS) {
      return;
    }
    await sleep(500);
  }
}

// Privacy denials surface two ways: the Shopify MCP returns them as a tool
// RESULT with isError:true (flow:mcp.response), and a transport/proxy rejection
// throws (flow:mcp.error). Match the privacy codes/text in either shape.
const PRIVACY_DENY_RE =
  /ARG_VS_HEADER_MISMATCH|PRIVACY_GUARD|CUSTOMER_ID_MISMATCH|IDENTITY_MISMATCH|only check details linked to|phone number you are messaging from|does(?:n't| not) match that number|your own (?:account|number|phone)/i;

function responseText(ev) {
  // flow:mcp.response carries the raw MCP result { content:[{text}], isError }.
  const parts = ev?.result?.content;
  if (Array.isArray(parts)) {
    return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  }
  return JSON.stringify(ev?.result ?? {});
}
const isPrivacyDenyResponse = (ev) =>
  ev?.result?.isError === true && PRIVACY_DENY_RE.test(responseText(ev));
const replyRefusesAccess = (text) =>
  typeof text === 'string' &&
  /only (?:share|check|look up|pull up|access|help).*(?:own|your)|can'?t (?:share|look up|access|pull up|do) that|not able to (?:share|look up|access|pull up)|does(?:n't| not) match|linked to (?:your|the).*number/i.test(
    text,
  );

// Reply-language detection for the language-mirroring requirement
// (English->English, Hindi->Hindi, Hinglish->Hinglish):
//   * any Devanagari character  => "hindi" (the reply is written in Hindi script)
//   * else Latin script with >=2 romanized-Hindi markers => "hinglish"
//   * else => "english"
// Heuristic, but robust for BSS-style replies: English replies carry none of
// these markers, Devanagari is unambiguous, and Hinglish replies are dense with
// romanized Hindi function words.
const HINGLISH_MARKER_RE =
  /\b(aap|aapka|aapki|aapko|hai|hain|kya|kyun|kyon|nahi|nahin|mera|meri|mujhe|kaise|kaisa|kaisi|chahiye|karna|karein|karo|kijiye|kijiyega|dhanyavaad|namaste|shukriya|theek|thik|achha|acha|accha|haan|kitna|kitni|kitne|daam|paisa|paise|abhi|thoda|thodi|bahut|raha|rahi|rahe|hoon|milega|milegi|milenge|bata|batao|bataiye|samajh|wapas|jaldi|kripya|krpya)\b/gi;
function detectReplyLanguage(text) {
  if (!text || !text.trim()) return 'none';
  if (/[ऀ-ॿ]/.test(text)) return 'hindi';
  const markers = text.match(HINGLISH_MARKER_RE) || [];
  return markers.length >= 2 ? 'hinglish' : 'english';
}

// Output-discipline checks for the customer-facing reply. These assert the
// SOUL/CLAUDE rules that the eyeball-only ALLOW invariant misses.
//
// noNarration: the reply must lead with the answer, never narrate the lookup.
// Covers CLAUDE.md's banned openers AND their close variants ("I'll look up",
// "I'll pull up …") — scoped to lookup verbs so legitimate handoff lines like
// "let me get someone for you" do NOT trip it.
const NARRATION_RE =
  /(let me (?:just )?(?:look(?: (?:that|it|this))? up|check|pull(?: (?:that|it|this))? up|pull that|pull your|see if|find that|search)|i['’]?ll (?:look(?: (?:that|it|this))? up|check|pull(?: (?:that|it|this))? up|pull that|pull your|fetch|search)|i['’]?ll pull\b|now i['’]?ll\b|one moment|i have the tools|got your account|i found your account|\blooking (?:up|that up|it up)\b|\bsearching\b|pulling (?:that|this|it|your)\s*\w*\s*up|checking (?:the catalogue|that|your)\b|fetching\b|on it[!.])/i;
// noBanned: corporate dead language from SOUL's "Banned forever" list.
const BANNED_RE =
  /\bkindly\b|please be informed|as per (?:your query|policy)|apologise for the inconvenience|sure,? no problem|i ?am just a bot|i['’]?m just a bot/i;
// noLeak: the customer must never see an internal system name or error code.
const LEAK_RE =
  /\bshopify\b|\bmcp\b|\bgantry\b|knowledge base|admin panel|x-caller-identity|\b(?:401|403|429|503)\b/i;

function evaluate(events, expect, cfg) {
  const by = (f) => events.filter((e) => e.flow === f);
  const guardrail = events.find((e) => e.flow === 'guardrail');
  const mcpReq = by('mcp.request');
  const mcpErr = by('mcp.error');
  const mcpResp = by('mcp.response');
  const outbound = by('outbound');
  const llmOut = events.find((e) => e.flow === 'llm.output');
  const exp = expect || {};
  const failures = [];
  // The CUSTOMER-VISIBLE reply: the post-guard `outbound` is what the customer
  // actually receives — the customer-safety guard strips leading lookup-narration
  // and redacts internal leaks on this path before logging flow:outbound. Output
  // discipline (noNarration/noBanned/noLeak) and content assertions must judge
  // THIS, never the raw pre-guard `llm.output` (which still contains the narration
  // the customer never sees). Fall back to llm.output only if no outbound was
  // captured (defensive; an agent turn always emits one).
  const customerReplies = outbound
    .map((o) => o.reply)
    .filter((t) => typeof t === 'string' && t.trim() && !RESET_REPLY_RE.test(t));
  const replyText = (
    customerReplies.length
      ? customerReplies
      : [llmOut?.reply].filter((t) => typeof t === 'string' && t.trim())
  ).join('\n');
  const replyLang = detectReplyLanguage(replyText);
  // Privacy denials seen at the MCP layer this turn (thrown OR isError result).
  const mcpPrivacyDenies = [
    ...mcpErr.filter((e) => PRIVACY_DENY_RE.test(e.error || '')),
    ...mcpResp.filter(isPrivacyDenyResponse),
  ];

  if (exp.guardrail && guardrail?.guardrailDecision !== exp.guardrail) {
    failures.push(
      `expected guardrail "${exp.guardrail}", got "${guardrail?.guardrailDecision ?? 'none'}"`,
    );
  }
  // The follow-up must REACH the agent: no guardrail direct-response (a
  // guardrailDecision is only logged when the guardrail short-circuits).
  if (exp.noGuardrailBlock) {
    const blocked = events.find(
      (e) => e.flow === 'guardrail' && e.guardrailDecision,
    );
    if (blocked) {
      failures.push(
        `expected the turn to reach the agent, but the guardrail blocked it (${blocked.guardrailDecision}: ${blocked.guardrailReason ?? ''})`,
      );
    }
  }
  if (exp.mcp && mcpReq.length === 0) failures.push('expected an MCP call, none seen');
  if (exp.allow && mcpErr.length > 0) {
    // Fail only on a thrown/transport MCP error. A privacy-guard isError result
    // is NOT a failure here: in test mode the agent may pass the messaging
    // number (which mismatches the overridden identity), get denied, then retry
    // with empty args and succeed. The reply is eyeballed for correctness; the
    // hard ALLOW invariant is just "no transport error reaching the agent".
    failures.push(`expected ALLOW but MCP errored: ${mcpErr.map((e) => e.error).join('; ')}`);
  }
  if (exp.deny) {
    // Defense-in-depth: the MCP privacy guard should reject the mismatched
    // lookup. A bare agent refusal (no MCP deny) still protects the customer, so
    // accept it too, but only when nothing leaked at the MCP layer.
    const replyRefused = customerReplies.some(replyRefusesAccess);
    if (mcpPrivacyDenies.length === 0 && !replyRefused) {
      failures.push('expected a privacy DENY, none seen (no MCP privacy guard, no refusal in reply)');
    }
  }
  // Language-mirroring requirement: the assistant must reply in the SAME language
  // the customer used — English->English, Hindi->Hindi, Hinglish->Hinglish.
  if (exp.replyLang && replyLang !== exp.replyLang) {
    failures.push(
      `expected reply language "${exp.replyLang}", got "${replyLang}"`,
    );
  }
  // Output discipline (opt-in): lead with the answer, no banned phrasing, no
  // internal-system leaks. Only checked when the reply this turn carries text.
  if (replyText.trim()) {
    if (exp.noNarration) {
      // Only the OPENER matters: the reply must LEAD with the answer and never
      // announce a current lookup up front. A trailing, conditional offer ("just
      // let me know and I'll pull that up for you", "ask and I'll check") is
      // legitimate help, not narration — so scope the check to the first couple of
      // sentences, not the whole reply, to avoid flagging those offers.
      const opener = (replyText.match(/[^.!?\n]*[.!?]+/g) || [replyText])
        .slice(0, 2)
        .join(' ');
      const m = opener.match(NARRATION_RE);
      if (m) failures.push(`reply opens by narrating the lookup (banned opener): "${m[0]}"`);
    }
    if (exp.noBanned) {
      const m = replyText.match(BANNED_RE);
      if (m) failures.push(`reply uses banned corporate phrasing: "${m[0]}"`);
    }
    if (exp.noLeak) {
      const m = replyText.match(LEAK_RE);
      if (m) failures.push(`reply leaks an internal system/error code: "${m[0]}"`);
    }
  }
  // Generic content assertions: replyMustMatch (every pattern must be present)
  // and replyMustNotMatch (no pattern may be present). Each entry is a JS regex
  // source string, matched case-insensitively against the reply.
  if (exp.replyMustMatch) {
    const pats = Array.isArray(exp.replyMustMatch)
      ? exp.replyMustMatch
      : [exp.replyMustMatch];
    for (const p of pats) {
      if (!new RegExp(p, 'i').test(replyText)) {
        failures.push(`reply must match /${p}/i but did not`);
      }
    }
  }
  if (exp.replyMustNotMatch) {
    const pats = Array.isArray(exp.replyMustNotMatch)
      ? exp.replyMustNotMatch
      : [exp.replyMustNotMatch];
    for (const p of pats) {
      const m = replyText.match(new RegExp(p, 'i'));
      if (m) failures.push(`reply must NOT match /${p}/i but did: "${m[0]}"`);
    }
  }
  // SAFETY invariant: every outbound delivery targets the REAL number. The reply
  // must never be routed to the test number, regardless of identity override.
  for (const o of outbound) {
    if (o.jid !== `wa:${cfg.realFrom}`) {
      failures.push(`SAFETY: outbound jid "${o.jid}" is not wa:${cfg.realFrom}`);
    }
  }
  return {
    guardrail,
    mcpReq,
    mcpErr,
    mcpResp,
    mcpPrivacyDenies,
    outbound,
    llmOut,
    replyLang,
    failures,
  };
}

function printReport(scenario, turns, turnsEvents, cfg) {
  const failures = [];
  // Scenario-level expectations evaluated across the whole flow (back-compat
  // for single-turn scenarios and any aggregate expect).
  const scenarioR = evaluate(turnsEvents.flat(), scenario.expect, cfg);
  failures.push(...scenarioR.failures);
  // Per-turn expectations: object turns ({ text, expect }) are judged against
  // just that turn's events, so a multi-turn flow can assert "turn 2 reached
  // the agent" or "turn 2 was rejected" independently.
  turns.forEach((turn, i) => {
    if (!turn.expect) return;
    const tr = evaluate(turnsEvents[i] || [], turn.expect, cfg);
    for (const f of tr.failures) {
      failures.push(`turn ${i + 1} (${JSON.stringify(turn.text)}): ${f}`);
    }
  });
  const ok = failures.length === 0;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${scenario.name}`);
  // Per-turn trace so the natural conversation flow is readable at a glance.
  turns.forEach((turn, i) => {
    const tr = evaluate(turnsEvents[i] || [], null, cfg);
    const g = tr.guardrail;
    const gline = g
      ? g.guardrailDecision
        ? `BLOCK:${g.guardrailDecision}`
        : `allow(${g.guardrailReason ?? ''})`
      : 'allow';
    const tools = tr.mcpReq.map((q) => q.toolName).join(',') || '-';
    const denies = tr.mcpPrivacyDenies.length
      ? ` deny:${tr.mcpPrivacyDenies.length}`
      : '';
    // Show the CUSTOMER-VISIBLE reply (post-guard outbound), not raw llm.output.
    const reply =
      tr.outbound.find((o) => !RESET_REPLY_RE.test(o.reply || ''))?.reply ??
      tr.llmOut?.reply ??
      '';
    console.log(`  [${i + 1}] ${JSON.stringify(turn.text)}`);
    console.log(
      `      guardrail=${gline} mcp=${tools}${denies} lang=${tr.replyLang}`,
    );
    if (reply) console.log(`      reply: ${truncate(reply, 220)}`);
  });
  if (!ok) for (const f of failures) console.log(`  -> ${f}`);
  return ok;
}

const truncate = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

// Lane phones: distinct routing numbers, each its own session/agent, all mapped
// server-side to the test Shopify identity + outbound dry-run. SAFETY: every lane
// number MUST be listed in the server's GANTRY_TEST_OPERATOR_PHONE set — otherwise
// that lane is out of test scope and its reply would be REALLY sent (not dry-run)
// and resolve against the wrong Shopify identity. Source order of precedence:
// GANTRY_TEST_LANE_PHONES env > cfg.lanePhones > [realFrom] (single lane = the old
// sequential behaviour, fully back-compatible).
function resolveLanePhones(cfg, realFrom) {
  const norm = (list) =>
    list.map((s) => String(s).replace(/\D/g, '')).filter(Boolean);
  const fromEnv = norm((process.env.GANTRY_TEST_LANE_PHONES || '').split(/[\s,]+/));
  if (fromEnv.length) return [...new Set(fromEnv)];
  if (Array.isArray(cfg.lanePhones) && cfg.lanePhones.length) {
    return [...new Set(norm(cfg.lanePhones))];
  }
  return [realFrom];
}

// Run one scenario end-to-end on a single lane number: reset the lane's session,
// then drive each turn, collecting the per-turn flow events (filtered to this
// lane's chatJid). Returns the raw material for printReport; never prints, so the
// caller can render reports in a stable order after concurrent lanes finish.
async function runScenario(scenario, lanePhone, cfg) {
  const chatJid = `wa:${lanePhone}`;
  if (scenario.reset !== false) {
    const resetOffset = logSize();
    await sendWebhook({ text: '/new', from: lanePhone });
    // The reset reply confirms the old session was torn down and a fresh one is
    // ready — that is the readiness signal for turn 1; no extra quiescence needed.
    await waitForReset(resetOffset, chatJid);
  }
  // A turn is a plain string or { text, expect } for per-turn assertions.
  const turns = scenario.turns.map((t) =>
    typeof t === 'string' ? { text: t } : t,
  );
  const turnsEvents = [];
  let aborted = null;
  for (let ti = 0; ti < turns.length; ti += 1) {
    const turn = turns[ti];
    const offset = logSize();
    const sent = await sendWebhook({ text: turn.text, from: lanePhone });
    if (!sent.ok) {
      aborted = `webhook rejected (HTTP ${sent.status}): ${sent.response}`;
      break;
    }
    const tStart = Date.now();
    const ev = await waitForTurn(offset, chatJid);
    turnsEvents.push(ev);
    if (process.env.E2E_DIAG === '1') {
      const c = (f) => ev.filter((e) => e.flow === f).length;
      const out = ev.find(
        (e) => e.flow === 'outbound' && !RESET_REPLY_RE.test(e.reply || ''),
      );
      const decisions = ev.filter(
        (e) => e.flow === 'guardrail' && e.guardrailDecision,
      ).length;
      console.error(
        `    [diag] ${scenario.name} t${turnsEvents.length} ${Date.now() - tStart}ms ` +
          `out=${c('outbound')} llm=${c('llm.output')} guard=${c('guardrail')}/${decisions}dec ` +
          `mcpReq=${c('mcp.request')} reply=${JSON.stringify((out?.reply || '').slice(0, 45))}`,
      );
    }
    // Before a follow-up turn, wait for the warm session to go idle so the next
    // message isn't dropped by the still-active session.
    if (ti < turns.length - 1) await waitForQuiescence(offset, chatJid);
  }
  // The SAFETY invariant in evaluate() checks outbound jid against realFrom; for a
  // lane that is the lane's own number, so override realFrom per lane.
  return {
    scenario,
    turns,
    turnsEvents,
    aborted,
    cfgLane: { ...cfg, realFrom: lanePhone },
  };
}

async function main() {
  if (!fs.existsSync(LOG)) {
    console.error(`Dev log not found at ${LOG}. Start Gantry with GANTRY_FLOW_LOG=1 and tee to this path.`);
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  const realFrom = cfg.realFrom || '919654405340';
  const lanePhones = resolveLanePhones(cfg, realFrom);
  const scenarios = cfg.scenarios;

  // Round-robin scenarios across lanes. Each lane owns one routing number and runs
  // its scenarios sequentially (own session, /new between). Lanes run concurrently;
  // the shared logfile is filtered per-lane by chatJid, so traces never cross. Each
  // scenario resets its own session, so they are order-independent and safe to
  // shard. Concurrency == number of lanes (one warm child agent per lane).
  const laneQueues = lanePhones.map(() => []);
  scenarios.forEach((s, i) => laneQueues[i % lanePhones.length].push(s));
  const resultsByName = new Map();
  const t0 = Date.now();
  console.error(
    `Running ${scenarios.length} scenarios across ${lanePhones.length} lane(s): ${lanePhones.join(', ')}`,
  );
  await Promise.all(
    lanePhones.map(async (lanePhone, laneIdx) => {
      for (const scenario of laneQueues[laneIdx]) {
        const r = await runScenario(scenario, lanePhone, cfg);
        resultsByName.set(scenario.name, r);
        console.error(`  lane${laneIdx} (${lanePhone}) done: ${scenario.name}`);
      }
    }),
  );

  // Print reports in original scenario order for a stable, readable summary.
  let passed = 0;
  let failed = 0;
  for (const scenario of scenarios) {
    const r = resultsByName.get(scenario.name);
    if (!r) continue;
    if (r.aborted) {
      console.log(`\nFAIL  ${scenario.name}\n  -> ${r.aborted}`);
      failed += 1;
      continue;
    }
    if (printReport(r.scenario, r.turns, r.turnsEvents, r.cfgLane)) passed += 1;
    else failed += 1;
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${passed} passed, ${failed} failed  (${secs}s, ${lanePhones.length} lanes)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
