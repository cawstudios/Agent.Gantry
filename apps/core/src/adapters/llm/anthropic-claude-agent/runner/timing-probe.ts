// MEASUREMENT-ONLY (not committed): env-gated runner timing probe.
// When GANTRY_TIMING_LOG is set, appends {t, handle, mark} JSONL so the cold
// boot can be split into node-boot / runner-setup / CLI-boot+MCP / first-inference.
// No-op (and never throws) when the env var is unset, so it is inert in prod.
import fs from 'fs';

const FILE = process.env.GANTRY_TIMING_LOG;
const HANDLE = process.env.GANTRY_AGENT_RUN_HANDLE || 'unknown';

export function timingMark(mark: string): void {
  if (!FILE) return;
  try {
    fs.appendFileSync(
      FILE,
      `${JSON.stringify({ t: Date.now(), handle: HANDLE, mark })}\n`,
    );
  } catch {
    // Measurement must never affect the run.
  }
}
