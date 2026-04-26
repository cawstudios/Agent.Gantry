# Current Verification Commands

Use Node `>=24 <26` for local development, CI, and runtime deployments. The package manager is `npm`.

## Setup

```bash
npm install
```

## Small Checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm run test:integration
npm run test:e2e
```

## Default Test And Build

```bash
npm test
npm run build
```

`npm test` runs the contracts build, unit tests, and integration tests. `npm run build` cleans generated build output, builds contracts and SDK packages, runs `tsc`, and copies Postgres migrations into `dist/`.

## Factory And Release Gates

```bash
python3 .codex/scripts/check_agents_hygiene.py
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/validate_work.py
```

`python3 .codex/scripts/verify.py` currently runs format, build, structural architecture, runtime truth, factory Python tests, typecheck, tests, and e2e unless overridden with `FACTORY_*` environment variables.

Use this command to inspect the deterministic verification contract without running every phase:

```bash
python3 .codex/scripts/verify.py --print-only
```

## Missing Or Currently Failing Commands

No missing verification command was identified during repository inspection. If a command fails during a future phase, record the command, failure mode, and date here before changing behavior.
