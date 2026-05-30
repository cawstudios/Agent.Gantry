/**
 * Decides how the agent child process is launched: from the compiled dist
 * `.js` runner (production default) or directly from the TypeScript source via
 * tsx (developer debugging).
 *
 * Why this exists: the child agent is spawned as `node <runnerArgs...>`. By
 * default that points at `dist/.../runner/index.js`, so breakpoints set in the
 * `.ts` source never bind and edits require a rebuild. Setting
 * `GANTRY_CHILD_RUNNER_FROM_SOURCE` swaps the launch to
 * `node --import tsx [--inspect-brk=PORT] <src>/runner/index.ts`, which runs the
 * source directly (live breakpoints, no rebuild).
 *
 * SECURITY / PROD SAFETY: this is a developer-only switch. It is off unless the
 * env flag is explicitly set, and it fails safe — if the source entry cannot be
 * found (e.g. an installed-from-npm runtime that ships only dist), it falls back
 * to the dist launch instead of crashing. The inspector flag is injected into
 * argv (not NODE_OPTIONS, which the spawn env intentionally strips).
 */

export const CHILD_RUNNER_FROM_SOURCE_ENV = 'GANTRY_CHILD_RUNNER_FROM_SOURCE';
export const CHILD_RUNNER_INSPECT_PORT_ENV = 'GANTRY_CHILD_RUNNER_INSPECT_PORT';

const DEFAULT_INSPECT_PORT = 9230;

export interface ChildRunnerLaunch {
  /** Arguments passed to `node` (i.e. spawn(execPath, runnerArgs)). */
  runnerArgs: string[];
  /** Which entry was selected — for logging/diagnostics. */
  mode: 'dist' | 'source';
  /** The inspector port opened, if any (source mode only). */
  inspectPort?: number;
}

export interface BuildChildRunnerLaunchInput {
  /** Compiled runner entry, e.g. <root>/dist/adapters/.../runner/index.js. */
  distRunnerPath: string;
  /**
   * Source runner entry, e.g. <root>/apps/core/src/adapters/.../runner/index.ts.
   * Undefined when the running build cannot locate a source tree.
   */
  sourceRunnerPath: string | undefined;
  /** Whether the source entry actually exists on disk (caller checks fs). */
  sourceExists: boolean;
  /** Raw env values (caller passes process.env entries). */
  fromSourceFlag: string | undefined;
  inspectPortRaw: string | undefined;
}

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}

/**
 * Parse the inspector-port override. Returns:
 *  - a finite port number to open the inspector on that port,
 *  - `null` when explicitly disabled ("none"/"off"/"0"/"false"),
 *  - the default port when unset/blank.
 */
function resolveInspectPort(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_INSPECT_PORT;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return DEFAULT_INSPECT_PORT;
  if (
    normalized === 'none' ||
    normalized === 'off' ||
    normalized === 'false' ||
    normalized === '0'
  ) {
    return null;
  }
  const port = Number.parseInt(normalized, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    // Invalid override: fall back to the default rather than failing the run.
    return DEFAULT_INSPECT_PORT;
  }
  return port;
}

/**
 * Pure decision function (no fs / env access) so it is trivially unit-testable.
 * The caller supplies resolved paths, an existence check, and raw env values.
 */
export function buildChildRunnerLaunch(
  input: BuildChildRunnerLaunchInput,
): ChildRunnerLaunch {
  const distLaunch: ChildRunnerLaunch = {
    runnerArgs: [input.distRunnerPath],
    mode: 'dist',
  };

  if (!isTruthyFlag(input.fromSourceFlag)) {
    return distLaunch;
  }

  // Flag is on but we have no usable source entry (e.g. installed dist-only
  // runtime). Fail safe: run dist rather than crash. The caller logs this.
  if (!input.sourceRunnerPath || !input.sourceExists) {
    return distLaunch;
  }

  const inspectPort = resolveInspectPort(input.inspectPortRaw);
  const runnerArgs: string[] = ['--import', 'tsx'];
  if (inspectPort !== null) {
    // 127.0.0.1 keeps the inspector loopback-only. -brk pauses on the first
    // line so a debugger can attach before the short-lived child runs.
    // runnerArgs.push(`--inspect=127.0.0.1:${inspectPort}`);
    runnerArgs.push(`--inspect-brk=127.0.0.1:${inspectPort}`);
  }
  runnerArgs.push(input.sourceRunnerPath);

  return {
    runnerArgs,
    mode: 'source',
    ...(inspectPort !== null ? { inspectPort } : {}),
  };
}
