# Media render capability + environment-facts guidance — goal prompt

Status: ACTIVE lane (user-locked 2026-07-20, grill session). Fixes the
2026-07-20 live failure chain where a sandboxed agent burned a session
discovering, one wall at a time, that it could not render an MP4.

## Root cause (one sentence)

The agent sandbox is provisioned blind: capabilities are discovered by runtime
failure, not provisioned up front or declared absent — the Chrome/Mach failure
was merely the layer where in-sandbox improvisation became impossible.

## The observed failure chain (live incident, 2026-07-20)

1. Render outputs written to ephemeral temp dirs got wiped (no durable
   convention communicated).
2. `npm install` hit the host's root-owned `~/.npm` (no seeded, writable
   package cache).
3. Remotion's render-time download of Chrome Headless Shell died in the
   sandbox (proxy-unaware DNS → ENOTFOUND; egress is default-allow but only
   through the loopback proxy).
4. TRUE BLOCKER: Chrome could not launch — `bootstrap_check_in
   org.chromium.Chromium.MachPortRendezvousServer: Permission denied (1100)`
   plus crashpad/profile writes to denied paths.
5. Artifact-store writes rejected while workspace-path attachments worked
   (that specific bug fixed on main: `3da53d9f6`, `e803e21fa`, `14d79783d`;
   loader dedup runs as a separate closeout lane).

## Empirical proof (2026-07-20, this machine)

A full Remotion 4.0.290 render (NeuralNet, 210/210 frames → 916 KB MP4)
succeeded INSIDE `@anthropic-ai/sandbox-runtime@0.0.52` (srt) with:

- Pinned `chrome-headless-shell` (Chrome for Testing 147.0.7727.57,
  puppeteer cache path) — no render-time download.
- A 2-line wrapper script passed as `--browser-executable` that appends
  `--single-process --no-sandbox`. Single-process Chrome never registers the
  MachPortRendezvousServer, which fully sidesteps the mach-register denial —
  srt exposes `mach-lookup` allowances only, and no `mach-register` key
  exists, so multi-process Chrome is impossible under srt by construction.
- `HOME` and `TMPDIR` pointed inside the sandbox's `allowWrite` root
  (user-data-dir, crashpad, Remotion caches all land there).
- srt network config: `allowLocalBinding: true` (DevTools websocket),
  `allowMachLookup: ["com.apple.FSEvents",
  "com.apple.SystemConfiguration.configd"]` — `configd` is the ONE addition
  vs gantry's current builder list; without it Chrome's network stack spins on
  `SCDynamicStoreCreate` and the DevTools endpoint never comes up.
  `enableWeakerNetworkIsolation: true` as gantry already sets on darwin.
- NOTE: these keys nest INSIDE `network` (a flat `allowMachLookup` is
  silently ignored by srt's schema — cost one debugging round).

Chrome's own sandbox is redundant inside the OS sandbox; `--no-sandbox` there
is the standard container posture, not a weakening.

## Locked decisions (user, 2026-07-20)

1. **Out-of-box capability**: new users' agents render video/screenshots with
   zero setup. Not opt-in, not fail-fast-only.
2. **Carrier = semantic capability + bundled skill**: a `media.render`-family
   semantic capability (pinned binaries, image-inventory-declared,
   preflight-honest when absent) AND a bundled skill carrying the working
   recipe. Availability is declared, never discovered by failure.
3. **Full pre-provision at setup**: gantry setup fetches hash-pinned
   `chrome-headless-shell` + static `ffmpeg` AND bakes a warm Remotion
   template project (node_modules installed). First render is fast and fully
   offline. ~400 MB disk, visible setup-doctor step. Inventory declares the
   capability only when every piece verifies.
4. **Generalize — environment-facts guidance**: the worker operating guidance
   gains a generated section (from image inventory + sandbox config):
   writable roots, egress-through-proxy note, provisioned toolchains with
   invocation recipes, known-impossible operations (e.g. multi-process
   Chrome). The general class fix; chosen over both "render only" and a full
   preflight subsystem.
5. **Lane**: starts immediately, parallel with ponytail Phase 4+ (user
   accepts merge-risk on capabilities/settings surfaces).

## Stated defaults (not grilled; overturn explicitly if wrong)

- Durable outputs: `<agent workspace>/media/` convention, delivery via the
  #234 workspace-direct path (≤25 MB); artifact store untouched.
- Seeded package cache: spawn env sets `npm_config_cache` (and pnpm
  equivalent) into the agent workspace so installs never touch host `~/.npm`.
- The `configd` mach-lookup one-liner lands in
  `buildSandboxRuntimeConfig` unconditionally (benign read-only service any
  Apple-networking binary needs).
- Skill covers video (Remotion), plus ffmpeg patterns (encode, gif,
  slideshow) with the same durable-output + delivery conventions.

## Implementation sketch (stages; each leaves tree green)

1. **Sandbox builder + spawn hygiene**: `configd` mach lookup; seeded package
   cache env in `agent-spawn-helpers.ts`; unit tests.
2. **Toolchain provisioning (setup doctor)**: new stage that downloads
   hash-pinned `chrome-headless-shell` + static ffmpeg into a gantry-owned
   toolchain dir, bakes the warm Remotion template (`npm ci`), runs a 2-frame
   smoke render under srt, and records results. Idempotent, resumable,
   loud on hash mismatch. Reuse the existing toolchain-artifact machinery
   (`adapters/artifacts/toolchains/`) where it fits.
3. **Capability + inventory**: `media.render` semantic capability with
   `local_cli` bindings (pinned executablePath/version/hash for both
   binaries), sandboxProfile network `required` + filesystem
   `workspace_write`; declared in the fixed-image inventory; the existing
   admission preflight then fails honest when absent.
4. **Bundled skill**: the recipe as a first-class skill — copy warm template,
   compose, render with `--browser-executable` wrapper (single-process
   flags), `HOME`/`TMPDIR` placement, outputs to `media/`, deliver
   workspace-direct. ffmpeg patterns included.
5. **Environment-facts guidance**: generated section in
   `OPERATING_GUIDANCE_BLOCK` (prompt-profile-service.ts) fed from inventory
   + sandbox settings. Keep it terse — facts and recipes, not prose.

## Verification gates

- Scripted srt smoke render (the empirical experiment, automated) — must
  produce a playable MP4 under the enforcing sandbox.
- **HARD GATE — direct mode**: the live default is the `direct` provider
  (Agent SDK's own seatbelt). The recipe must be verified on a real agent run
  in direct mode before the capability is declared for it; the srt result
  predicts success (identical failure signature) but does not prove it.
- Unit: provisioning idempotence + hash pinning; capability/inventory
  parsing; guidance rendering; spawn-env cache seeding.
- Test fixtures must avoid real key prefixes (autoreview scanner FP classes).

## Non-goals

- No host-side render service; no CDP screencast path (single-process
  in-sandbox rendering is proven and strictly simpler).
- No mach-register relaxation, no seatbelt profile surgery.
- No S3/artifact-store changes (separate held lane).
- No render-time downloads, ever — absence of a provisioned piece is a
  declared fact, not a download trigger.
