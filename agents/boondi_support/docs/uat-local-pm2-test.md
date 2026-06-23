# Local PM2 Smoke Test (before AWS)

Validate the **built (`dist/`) stack under pm2 on your Mac** before deploying to
EC2. This rehearses the production runbook (`uat-deployment-ec2.md`) locally — same
process model, only paths differ.

> **Dev-mode rule:** pm2 here is a one-off build test. **Do NOT run `pm2 startup`** —
> that installs a launchd boot service, which we don't use. Run → verify → tear down.

## 0. Pre-flight

Stop the dev stack first (it holds ports 4710 / 8081 / 8082 + the IPC lock):

```bash
pkill -f "apps/core/src/index.ts" 2>/dev/null; \
pkill -f "packages/mcp-shopify/src/index.ts" 2>/dev/null; \
pkill -f "packages/mcp-crm/src/index.ts" 2>/dev/null; \
pm2 delete all 2>/dev/null || true
```

Postgres up (your usual dev DB) and on the branch you want to test:

```bash
docker compose --env-file ~/gantry/.env up -d postgres
```

**Model token:** the stack reads it from Postgres (the encrypted Credential
Center), **not** from env or a file. It's handled as its own step — **§2 below**,
after the build (it uses the built CLI). Nothing to set here.

## 1. Build

```bash
npm run build
npm run build --workspace @gantry/mcp-crm
npm run build --workspace @gantry/mcp-shopify
```

## 2. Set the model token (only if `status` shows `missing`)

The token is an **encrypted row in Postgres**, not env or a file. On a fresh DB —
or after you've removed it — it reads `missing`, and you seed it **once**. This
needs **only Postgres up, not pm2/core**: the command self-migrates the DB and
writes the encrypted row itself. Run from a **normal Terminal** (not inside Claude
Code, so no injected token leaks in):

```bash
node dist/cli/index.js credentials model status        # `ready`? skip this section
# if `missing` — interactive: pick auth mode, then paste the secret
node dist/cli/index.js credentials model set anthropic
node dist/cli/index.js credentials model status        # → anthropic: ready
```

The prompt asks for **auth mode**, then the **secret**. Local test: either mode is
fine. **EC2 UAT: pick "API key" + a real `sk-ant-api…`** — the Claude Code OAuth
token shares a throttled 5-hour window.

> **Seed before pm2, never after.** Start pm2 with no token and core boots but every
> reply fails until you seed it — then you'd need `pm2 reload gantry-core` to pick up
> the new credential. Seeding first → core finds `ready` on boot, clean first run.

## 3. Run under pm2 (from a normal Terminal — not from inside Claude Code)

A clean shell keeps injected model env out (the ecosystem also blanks it as a backstop).

```bash
pm2 start agents/boondi_support/docs/ecosystem.local.config.cjs
pm2 status          # mcp-shopify / mcp-crm / gantry-core all 'online'
pm2 logs            # watch boot; Ctrl-C to stop tailing
```

`GANTRY_HOME` stays your existing `~/gantry` (same settings + model creds), and
`GANTRY_OUTBOUND_DRYRUN=1` means replies are generated/persisted but not sent.

## 4. Verify

```bash
curl -s localhost:4710/openapi.json -o /dev/null -w 'core %{http_code}\n'
curl -s localhost:8081/healthz; echo      # {"ok":true}
curl -s localhost:8082/healthz; echo      # {"ok":true}
```

All green = the built stack boots and is healthy under pm2. Optional: drive a test
message through the Control API / your admin app to confirm a real reply path.

## 5. Tear down

```bash
pm2 delete all
```

Back to normal dev (`npm run dev`) whenever you want.

## Notes

- **No `pm2 startup`** locally (dev-mode rule; it writes a launchd plist).
- If the agent ever uses the wrong/personal token, that's injected model env —
  relaunch pm2 from a clean Terminal.
- Only paths differ from EC2: `~/gantry` vs `/home/ubuntu/gantry`, your repo path
  vs `/opt/boondi/Agent.Gantry`.
