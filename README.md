<p align="center">
  A personal AI assistant runtime that stays small enough to understand and is meant to be customized in code.
</p>

---

## What MyClaw Is

MyClaw is a single-process Node.js assistant runtime. Messages come in from one or more channels, get stored in the configured runtime database, and are routed to host-managed agents through a host runtime process.

The project is intentionally small. The goal is not to be a framework with every feature built in. The goal is to give one person a secure, understandable base they can shape to fit their own workflow.

## Quick Start

```bash
npm i -g myclaw
myclaw
```

The first run is a guided CLI flow that collects setup choices first, then runs final doctor verification before marking the runtime ready.

### NPM Install First-Run Flow

If you install from npm and want the fastest path to a working bot:

```bash
npm i -g myclaw
myclaw
```

Then follow this order:

1. Run `myclaw` with no args.
2. Provide a Postgres database URL.
3. Choose your first channel: `Telegram` or `Slack`.
4. Follow the in-CLI provider guide, paste credentials, and pick a discovered chat/channel (or enter an ID manually).
5. Configure OneCLI as the credential broker for agent model access; raw Claude credentials are not stored in runtime `.env`.
6. Choose main model (`opus` recommended and pinned to Opus 4.7; `sonnet` or `opusplan` optional).
7. Confirm memory settings (memory on, embeddings off, dreaming on by default).
8. Choose whether to install/start a background service.
9. Review the final summary and choose `Create Runtime`; before this point Back, Resume Later, and Cancel are transactional.
10. Let setup write config, register the group, run final doctor verification, and show the ready screen.
11. Finish setup. The default is to exit cleanly; choose `Start MyClaw now` only if you want the runtime to begin listening immediately.

### CLI Commands

```bash
myclaw
myclaw setup
myclaw doctor
myclaw status
myclaw memory status
myclaw memory embeddings <off|openai>
myclaw memory dreaming <on|off>
myclaw start
myclaw telegram connect
myclaw slack connect
myclaw service install
myclaw service start
myclaw service stop
```

Defaults in v1:

- runtime home: `~/myclaw`
- runtime settings file: `~/myclaw/settings.yaml` (validated before `start`/`restart`)
- setup flow: guided multi-channel first run (choose Telegram or Slack)
- storage: Postgres through `MYCLAW_DATABASE_URL`
- memory: on
- embeddings: off (unless OpenAI key is provided and enabled)
- dreaming: on in guided setup; disable with `myclaw memory dreaming off`
- sender allowlist: `channels.<provider>.sender_allowlist` in `settings.yaml`
- session/admin allowlist: `channels.<provider>.control_allowlist` in `settings.yaml`

Runtime home is a single-cut contract. MyClaw reads `~/myclaw` by default unless `--runtime-home` or `MYCLAW_HOME` is set.

Canonical runtime settings live in `~/myclaw/settings.yaml`:

```yaml
storage:
  postgres:
    url_env: MYCLAW_DATABASE_URL
    schema: myclaw

memory:
  enabled: true
  root: memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: true
```

MyClaw uses Postgres for runtime state, jobs, events, memory, semantic search, and lexical search. Runtime readiness expects `pgvector`, `pg_trgm`, and `pg-boss` schema readiness.

For local development, a Docker Postgres container is supported:

```bash
docker run --name myclaw-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=myclaw \
  -p 5432:5432 \
  -v "${MYCLAW_HOME:-$HOME/myclaw}/postgres:/var/lib/postgresql/data" \
  -d pgvector/pgvector:pg16

docker exec -i myclaw-postgres \
  psql -U postgres -d myclaw \
  -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

When running from a repo checkout, an equivalent launcher is available:

```bash
npm run postgres:up
npm run postgres:url
```

Then set:

```bash
export MYCLAW_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/myclaw'
```

### Channel Setup

MyClaw supports multiple channels. You can connect Telegram and/or Slack:

```bash
myclaw telegram connect
myclaw slack connect
```

Notes:

- Telegram uses `TELEGRAM_BOT_TOKEN`; create it in Telegram by chatting with `@BotFather` and sending `/newbot`.
- For Telegram groups, add the bot to the group and send a message before discovery; if MyClaw must see every group message, make the bot an admin or disable Group Privacy in BotFather with `/setprivacy`.
- `myclaw telegram connect` auto-discovers recent chats and can register one without manual chat ID copy/paste. The human sender from the selected discovery message is added to `control_allowlist`, so `/new`, `/model`, `/dream`, and `/memory-status` work immediately.
- Slack uses Socket Mode with `SLACK_BOT_TOKEN` (`xoxb-...`) and `SLACK_APP_TOKEN` (`xapp-...`); create a Slack app, add a bot user/scopes, enable Socket Mode, generate the app-level token, install/reinstall the app, then invite it to the target channel or DM it once.
- `myclaw slack connect` auto-discovers accessible conversations and can register one directly.
- Slack tool permission approvals are deny-by-default until `SLACK_PERMISSION_APPROVER_IDS` is set. Guided setup asks for comma-separated Slack member IDs like `U0123456789`; these users can approve tool permissions and answer interactive prompts.
- Slack UX uses native Slack surfaces (threads, streaming updates, actions).

## Philosophy

- Small enough to understand. One process, a small set of core files, and straightforward data flow.
- Secure by explicit trust boundaries. The current runtime executes on host, so security depends on host controls, scoped mounts, and clear operational safeguards.
- Customized in code. If you want different behavior, change the code instead of stacking on configuration.
- Skills over core bloat. Reusable capabilities should be delivered as skills or narrowly scoped branches, not piled into the default runtime.
- AI-native operations. Setup, debugging, and maintenance should be easy to drive from Claude Code.

## What It Supports

- Multi-channel messaging
- Per-group context and memory
- Scheduled jobs
- Web access and browser automation
- Host runtime execution
- Skill-driven extensions and channel installation

## Memory And Continuity

Memory stores durable knowledge the agent should remember later:

- preferences
- decisions
- facts
- corrections
- constraints
- reusable procedures

Continuity is the runtime context that helps the agent pick up where it left off:

- current task state
- relevant remembered facts
- prior decisions
- recent work context
- open loops once commitment tracking is enabled
- dream lifecycle status (enabled/schedule/last run outcome)

Embeddings are off by default. Memory search and context injection still work without embeddings; embeddings only improve ranking when enabled.

Host runtime now injects a fresh memory/continuity block for every agent run (message and scheduler), so baseline recall does not depend on the agent deciding to call memory tools first. The block is sent as a separate structured untrusted data message, with a system-level boundary policy that forbids treating memory records as instructions or tool-use authority.

Scope defaults:

- `user` for personal preferences and per-user corrections
- `group` for active channel/chat memory (default)
- `global` only for explicitly cross-chat knowledge
- when `thread_id` exists, injected group/global memory is filtered to records saved with the same `topic_id`/`thread_id`

Runtime state and memory records are stored in Postgres through `MYCLAW_DATABASE_URL`.
Memory artifacts such as journals, session archives, and optional mirrors remain under `memory.root`.

## Runtime

MyClaw currently supports a single runtime mode: host execution.
Use `npm run dev` for local development and `npm start` for production start.

## Repository Development

Use this only when you are working on the source code:

```bash
git clone https://github.com/qwibitai/myclaw.git
cd myclaw
npm install
npm run build
# local testing entrypoint (equivalent CLI flow)
node index.js
```

## Testing

Test and harness files must live outside production source trees.

Approved test layout:

- `apps/core/test/unit/**`
- `apps/core/test/integration/**`
- `apps/core/test/e2e/**`
- `apps/core/test/harness/**`
- `packages/contracts/test/unit/**`

Do not add `*.test.ts` files under `apps/core/src/**` or `packages/*/src/**`.

Common commands:

```bash
npm run test:unit
npm run test:integration
npm test
npm run test:e2e
```

- `npm test` runs contracts build + unit + integration tests.
- `npm run test:e2e` runs hermetic end-to-end runtime flows without external service credentials.

## Shipped Chat Skills

Skills are agent instructions bundled into the npm package and synced into `~/myclaw/.claude/skills/`.

| Skill          | Purpose                                                               |
| -------------- | --------------------------------------------------------------------- |
| `/commands`    | List available chat commands and installed skill packs                |
| `myclaw-admin` | Internal administration reference used by agents when managing MyClaw |

Session commands are handled by the host runtime, not bundled skills:

```text
/compact
/new
/model
/model <value>
/model default
```

Optional skill packs like [gstack](https://github.com/garrytan/gstack) can be installed for additional capabilities (code review, QA, design review, security audits, and more). Run `/commands` after installing to see what's available.

## Session Commands

Use these as standalone chat messages:

```text
/compact
/new
/model
/model opus
/model sonnet
/model opusplan
/model default
```

- `/new` resets the current group session and archives the previous transcript.
- `/model <value>` switches the group model override only when validation succeeds. Prefer Claude Code aliases (`sonnet`, `opus`, `opusplan`) so MyClaw tracks current Claude defaults; pin exact model IDs only for advanced rollout control.
- Human shorthand such as `/model opus-4-7` is normalized to the safe Claude Code `opus` alias. Exact Opus 4.7 model IDs require a recent Claude Code version and account access, so MyClaw does not pin new installs to them by default.
- Session commands require `is_from_me` or explicit `control_allowlist` membership. `sender_allowlist: "*"` allows interaction; it does not grant admin/session-command rights.

## Claude Model Policy

MyClaw setup uses Claude Code aliases for user choices and does not pin those aliases by default:

- Default session model: `opus`
- Allowed Claude Code choices: `sonnet`, `opus`, `haiku`, `best`, `opusplan`, `sonnet[1m]`, `opus[1m]`
- Memory LLM API defaults: extractor `claude-haiku-4-5-20251001`, dreaming `claude-sonnet-4-6`, consolidation `claude-sonnet-4-6`
- The generated Claude settings JSON includes `model`, `availableModels`, and memory hooks.

The allowed model list is centralized in `apps/core/src/models/claude-model-registry.ts`. Keep Claude Code interactive defaults alias-first; only add exact model IDs when they are broadly supported and tested across Claude Code versions.

## Project Layout

Key paths:

- `apps/core/src/index.ts` - package/runtime entrypoint
- `apps/core/src/app/bootstrap/runtime-app.ts` - orchestrator lifecycle and runtime wiring
- `apps/core/src/runtime/group-queue.ts` - per-group queueing and retries
- `apps/core/src/runtime/agent-spawn.ts` - host agent execution path
- `apps/core/src/session/session-commands.ts` - host-managed slash commands
- `apps/core/src/infrastructure/postgres/schema/` - Postgres runtime, control-plane, job, and memory persistence
- `~/myclaw/agents/shared/CLAUDE.md` - static shared prompt guidance
- `~/myclaw/agents/*/SOUL.md` - per-agent personality prompt
- `~/myclaw/agents/*/CLAUDE.md` - static group-specific prompt guidance
- `MYCLAW_DATABASE_URL` - Postgres runtime and memory database
- `~/myclaw/memory/sessions/` - archived session summaries used for continuity recap
- `~/myclaw/memory/dreams/` - dream/refinement artifacts
- `~/myclaw/memory/.journal/` - memory journal files

## Factory Mode

This repo also supports a doc-driven factory workflow for planning, decomposition, testing, review, and PR readiness.

Start with:

```bash
python3 .codex/scripts/stage_orchestrator.py
```

Then read:

- [WORKFLOW.md](WORKFLOW.md)
- [docs/FACTORY.md](docs/FACTORY.md)
- [docs/QUALITY.md](docs/QUALITY.md)
- [docs/getting-started.md](docs/getting-started.md)

## Customizing

The intended workflow is simple: tell Claude Code what you want changed, keep the code readable, and prefer direct code edits over piles of configuration.

Examples:

- "Change the trigger word to `@Bob`."
- "Make scheduled summaries shorter."
- "Add a morning greeting flow."
- "Store weekly conversation summaries."

Reusable guided workflows can be added as skills under `~/myclaw/.claude/skills/`.

## Contributing

Contributions should keep the core runtime small and maintainable. Bug fixes, simplifications, docs improvements, and reusable skills are good fits. Broad feature creep in the default runtime is not.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution policy and branch-based skill model.

## Documentation

Project docs live in [`docs/`](docs/README.md). Product intent, architecture notes, and decisions live in-repo so planning and review can stay self-contained.
For npm users, start with [`docs/npm-cli-onboarding.md`](docs/npm-cli-onboarding.md).