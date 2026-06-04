// Pure assertions over a single turn's parsed flow events (see parseFlowEvents).
// crm: assert a specific boondi-crm capture fired with the right fields/result.
// crmNone: assert NO write-capture (record_query/upgrade_to_lead/update_record) fired
//          (a get_open_records read is allowed — it backs returning-customer greetings).
const WRITE_TOOLS = new Set(['record_query', 'upgrade_to_lead', 'update_record']);

const crmRequests = (events) =>
  events.filter((e) => e.flow === 'mcp.request' && e.serverName === 'boondi-crm');

function parseCrmResult(events, toolName) {
  const r = events.find(
    (e) =>
      e.flow === 'mcp.response' &&
      e.serverName === 'boondi-crm' &&
      e.toolName === toolName,
  );
  const parts = r?.result?.content;
  if (!Array.isArray(parts)) return null;
  try {
    return JSON.parse(
      parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(''),
    );
  } catch {
    return null;
  }
}

export function evaluateCrm(events, expect = {}) {
  const failures = [];
  const reqs = crmRequests(events);

  if (expect.crmNone) {
    const writes = reqs.filter((r) => WRITE_TOOLS.has(r.toolName));
    if (writes.length) {
      failures.push(
        `crmNone: expected no capture, saw ${writes.map((w) => w.toolName).join(', ')}`,
      );
    }
    return failures;
  }
  const exp = expect.crm;
  if (!exp) return failures;

  const req = reqs.find((r) => r.toolName === exp.tool);
  if (!req) {
    failures.push(
      `crm: expected a boondi-crm "${exp.tool}" call, saw [${reqs.map((r) => r.toolName).join(', ') || 'none'}]`,
    );
    return failures;
  }
  const args = req.arguments || {};
  if (exp.intentCategory && args.intentCategory !== exp.intentCategory) {
    failures.push(
      `crm: intentCategory expected "${exp.intentCategory}", got "${args.intentCategory ?? 'none'}"`,
    );
  }
  if (exp.argsMustInclude) {
    for (const [k, v] of Object.entries(exp.argsMustInclude)) {
      const got = args[k];
      const present = got !== undefined && got !== null && got !== '';
      if (v === true) {
        if (!present) failures.push(`crm: arg "${k}" expected present, missing`);
      } else if (got !== v) {
        failures.push(
          `crm: arg "${k}" expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`,
        );
      }
    }
  }
  if (exp.status || exp.expectScored || exp.band) {
    const result = parseCrmResult(events, exp.tool);
    if (!result) {
      failures.push(
        `crm: expected a parseable "${exp.tool}" response payload, none found`,
      );
    } else {
      if (exp.status && result.status !== exp.status) {
        failures.push(
          `crm: response status expected "${exp.status}", got "${result.status ?? 'none'}"`,
        );
      }
      if (exp.expectScored && typeof result.score !== 'number') {
        failures.push(`crm: expected numeric score, got ${JSON.stringify(result.score)}`);
      }
      if (exp.band && result.band !== exp.band) {
        failures.push(`crm: band expected "${exp.band}", got "${result.band ?? 'none'}"`);
      }
    }
  }
  return failures;
}
