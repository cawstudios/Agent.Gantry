# Current Verification Commands

Use Node 24 LTS for local development, CI, and runtime deployments:

```bash
nvm use
npm install
npm run typecheck
npm run lint
npm test
```

The package engine policy is `>=24 <26`. Enterprise and runtime deployments should use LTS Node, not Current-only Node, so production behavior does not depend on short-lived Current releases.

For release gates, also run:

```bash
npm run build
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
```
