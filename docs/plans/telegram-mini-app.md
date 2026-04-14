# MyClaw Telegram Mini App — Plan Mode UI

## Goal

Build a Telegram Mini App that gives users a rich interactive experience for reading, reviewing, and modifying agent plans. Instead of plain text messages, users get a native-feeling app inside Telegram with expandable sections, approve/reject buttons, inline editing, and real-time agent communication.

## Documentation References

Search these when implementing:

| Resource | URL | Use For |
|----------|-----|---------|
| Telegram Mini Apps Official Docs | https://core.telegram.org/bots/webapps | API reference, lifecycle, security |
| Telegram Bot API | https://core.telegram.org/bots/api | sendMessage, web_app buttons, answerWebAppQuery, callback_query |
| @telegram-apps/sdk-react | https://www.npmjs.com/package/@telegram-apps/sdk-react | React hooks and components for Mini App SDK |
| TelegramUI Components | https://github.com/telegram-mini-apps-dev/TelegramUI | Native Telegram-style React components |
| React Template | https://github.com/Telegram-Mini-Apps/reactjs-template | Starter template (React + TypeScript + Vite + tma.js) |
| Awesome TMA List | https://github.com/telegram-mini-apps-dev/awesome-telegram-mini-apps | Community resources, examples, libraries |
| Init Data Docs | https://docs.telegram-mini-apps.com/platform/init-data | Auth validation, user identity |
| Mini App Methods | https://docs.telegram-mini-apps.com/platform/methods | Available client-side methods |
| Mini Apps Handbook | https://dev.to/simplr_sh/telegram-mini-apps-creation-handbook-58em | Step-by-step creation guide |
| Bot Features (Buttons) | https://core.telegram.org/bots/features | Menu button, inline keyboard, web_app launch |
| MyClaw Codebase | ~/workdir/myclaw | Source code for all integrations |
| MyClaw Telegram Channel | ~/workdir/myclaw/apps/core/src/channels/telegram.ts | Existing grammy bot, callback handling |
| MyClaw IPC System | ~/workdir/myclaw/apps/core/src/runtime/ipc.ts | Host-side IPC processor (1,522 lines) |
| MyClaw Agent Runner MCP | ~/workdir/myclaw/packages/agent-runner/src/ipc-mcp-stdio.ts | Agent-side MCP tools (send_message, scheduler, etc.) |
| MyClaw Message Router | ~/workdir/myclaw/apps/core/src/messaging/router.ts | Outbound message formatting |
| MyClaw Types | ~/workdir/myclaw/apps/core/src/core/types.ts | Channel interface, RegisteredGroup, NewMessage |

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Centrally Hosted Frontend (Cloudflare Pages / Vercel)        │
│  URL: https://app.myclaw.dev                                  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Mini App (React + Vite, static build)      │  │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────────┐  │  │
│  │  │Plan View │ │Section   │ │ Inline Editor         │  │  │
│  │  │Navigator │ │Detail    │ │ (edit plan sections)  │  │  │
│  │  └──────────┘ └──────────┘ └───────────────────────┘  │  │
│  │         │           │               │                  │  │
│  │         └───────────┴───────────────┘                  │  │
│  │                     │                                  │  │
│  │            @telegram-apps/sdk                          │  │
│  │         (initData, theme, haptics)                     │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        │ HTTPS (API URL from query param)     │
└────────────────────────┼─────────────────────────────────────┘
                         │
┌────────────────────────┼─────────────────────────────────────┐
│                    Telegram Client                             │
│  Bot sends: web_app { url: "app.myclaw.dev/plans/X?api=..." } │
└────────────────────────┼─────────────────────────────────────┘
                         │
┌────────────────────────┼────────────────────────────────────┐
│  MyClaw Core (single Node.js process)                        │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Telegram Bot (grammy, polling)        ← existing       │ │
│  │  Message Loop / IPC Watcher            ← existing       │ │
│  │  Task Scheduler                        ← existing       │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────┴──────────────────────────────────┐ │
│  │  Mini App API Server (Fastify, same process) ← NEW      │ │
│  │  POST /api/auth/validate  (initData via HMAC-SHA-256)   │ │
│  │  GET  /api/plans/:id                                    │ │
│  │  GET  /api/plans/:id/stream  (SSE for real-time)        │ │
│  │  POST /api/plans/:id/sections/:idx/approve              │ │
│  │  POST /api/plans/:id/sections/:idx/reject               │ │
│  │  POST /api/plans/:id/sections/:idx/edit                 │ │
│  └─────────────────────┬──────────────────────────────────┘ │
│                        │                                     │
│  ┌─────────────────────┴──────────────────────────────────┐ │
│  │  Plan State Store (JSON files)                          │ │
│  │  ~/myclaw/data/plans/{groupFolder}/{planId}.json        │ │
│  └─────────────────────┬──────────────────────────────────┘ │
│                        │ direct function call (same process) │
│  ┌─────────────────────┴──────────────────────────────────┐ │
│  │  IPC Watcher                                            │ │
│  │  Picks up plan-events/, routes to active agent session  │ │
│  └─────────────────────┬──────────────────────────────────┘ │
│                        │                                     │
│  ┌─────────────────────┴──────────────────────────────────┐ │
│  │  Agent (Claude)                                         │ │
│  │  MCP tools: create_plan, update_plan_section,           │ │
│  │  wait_for_plan_feedback                                 │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Current State (What Exists)

| Component | Status | File |
|-----------|--------|------|
| Telegram bot (grammy, polling) | Done | `apps/core/src/channels/telegram.ts` |
| Inline keyboard (permissions only) | Done | `telegram.ts:1276-1339` |
| callback_query handler | Done (permissions only) | `telegram.ts:780-840` |
| send_message MCP tool | Done (text only) | `ipc-mcp-stdio.ts:206-232` |
| Streaming output | Done | `telegram.ts:1099-1192` |
| Message formatting (MarkdownV2) | Done | `router.ts`, `text-styles.ts` |
| Plan mode | Not started | — |
| Mini App | Not started | — |
| General button support | Not started | — |
| Plan state management | Not started | — |

## Plan Sections

### Phase 1: Mini App Scaffold (apps/mini-app/)

**Goal:** Standalone React app using the official template, served locally, openable from Telegram.

#### 1.1 Create the Mini App package

```
apps/mini-app/
├── package.json          # React + Vite + @telegram-apps/sdk-react
├── vite.config.ts        # Dev server with HTTPS (mkcert)
├── tsconfig.json
├── index.html
├── src/
│   ├── main.tsx          # Entry point, TMA SDK init
│   ├── App.tsx           # Root component with router
│   ├── pages/
│   │   ├── PlanView.tsx  # Main plan review page
│   │   └── Home.tsx      # Landing / plan list
│   ├── components/
│   │   ├── PlanSection.tsx       # Expandable section card
│   │   ├── SectionActions.tsx    # Approve/Reject/Edit buttons
│   │   ├── InlineEditor.tsx      # Text editor for section edits
│   │   ├── PlanProgress.tsx      # Overall plan progress bar
│   │   └── StatusBadge.tsx       # Section status indicator
│   ├── hooks/
│   │   ├── usePlan.ts           # Plan data fetching + SSE streaming
│   │   ├── useAuth.ts           # initData extraction + validation
│   │   └── useTelegram.ts       # TMA SDK hooks (theme, haptics, back button)
│   ├── api/
│   │   └── client.ts            # API client for Mini App server
│   ├── types/
│   │   └── plan.ts              # Plan, Section, Status types
│   └── lib/
│       └── theme.ts             # Map Telegram theme to app theme
```

**Dependencies:**
- `@telegram-apps/sdk-react` — TMA SDK React bindings
- `@telegram-apps/telegram-ui` — Native Telegram-style components (TelegramUI)
- `react-router-dom` — Page routing
- `vite` + `@vitejs/plugin-react` — Build tooling
- `vite-plugin-mkcert` — HTTPS for local dev

**Key decisions:**
- Use TelegramUI for native look and feel (buttons, cells, sections match Telegram)
- SSE (Server-Sent Events) for real-time plan updates, not WebSocket (simpler, survives backgrounding better)
- Plan data flows: Mini App → API → IPC → Agent, Agent → IPC → API → SSE → Mini App

#### 1.2 Plan data model

```typescript
interface Plan {
  id: string;                    // uuid
  groupFolder: string;           // which group this plan belongs to
  title: string;
  status: 'draft' | 'reviewing' | 'approved' | 'rejected' | 'executing';
  sections: PlanSection[];
  createdAt: string;             // ISO timestamp
  updatedAt: string;
  agentSessionId?: string;       // active agent session working on this
}

interface PlanSection {
  index: number;
  title: string;
  content: string;               // markdown
  status: 'pending' | 'approved' | 'rejected' | 'editing' | 'executing' | 'done';
  userFeedback?: string;         // user's edit suggestion
  agentRevision?: string;        // agent's revised content after feedback
  decidedAt?: string;
  decidedBy?: string;            // telegram user who acted
}

type PlanEvent =
  | { type: 'section_approved'; planId: string; sectionIndex: number; userId: string }
  | { type: 'section_rejected'; planId: string; sectionIndex: number; userId: string; reason?: string }
  | { type: 'section_edited'; planId: string; sectionIndex: number; userId: string; newContent: string }
  | { type: 'plan_approved'; planId: string; userId: string }
  | { type: 'plan_rejected'; planId: string; userId: string };
```

#### 1.3 Register as workspace package

Add to root `package.json` workspaces:
```json
"workspaces": ["packages/agent-runner", "apps/mini-app"]
```

---

### Phase 2: Mini App Server (built into MyClaw core)

**Goal:** HTTP API embedded in MyClaw's existing process that bridges the Mini App frontend to the IPC system. No separate server — Fastify starts inside the same Node.js process alongside grammy and the message loop.

#### 2.1 Server setup

The API server runs inside MyClaw's process. It does NOT serve the frontend — that's hosted centrally on `app.myclaw.dev`. This server only handles API requests from the Mini App.

```typescript
// New file: apps/core/src/mini-app/server.ts
// Called from apps/core/src/index.ts at startup

import Fastify from 'fastify';
import cors from '@fastify/cors';

export async function startMiniAppServer(port = 3100) {
  const app = Fastify();

  // Allow requests from the centrally hosted Mini App
  app.register(cors, { origin: 'https://app.myclaw.dev' });

  // API routes (auth, plans, SSE)...
  await app.listen({ port, host: '0.0.0.0' });
}
```

#### 2.2 Server endpoints

```typescript
// New file: apps/core/src/mini-app/server.ts

// Auth
POST /api/auth/validate
  Body: { initData: string }
  Response: { valid: boolean, user: TelegramUser }
  // Validates initData using bot token HMAC-SHA-256

// Plans
GET  /api/plans
  Response: Plan[]
  // List plans for the authenticated user's groups

GET  /api/plans/:id
  Response: Plan
  // Full plan with all sections

GET  /api/plans/:id/stream
  Response: SSE stream
  // Real-time updates: section status changes, agent revisions
  // Events: plan_updated, section_status_changed, agent_revision

// Actions
POST /api/plans/:id/sections/:idx/approve
  Response: { ok: true }
  // Writes approve event to IPC

POST /api/plans/:id/sections/:idx/reject
  Body: { reason?: string }
  Response: { ok: true }

POST /api/plans/:id/sections/:idx/edit
  Body: { content: string }
  Response: { ok: true }

POST /api/plans/:id/approve-all
  Response: { ok: true }
  // Bulk approve remaining sections

POST /api/plans/:id/reject
  Body: { reason?: string }
  Response: { ok: true }
```

#### 2.3 Auth validation

```typescript
// Validate Telegram initData using HMAC-SHA-256
import crypto from 'crypto';

function validateInitData(initData: string, botToken: string): boolean {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  return calculatedHash === hash;
}
```

#### 2.4 Plan state store

```
~/myclaw/data/plans/{groupFolder}/{planId}.json
```

Simple JSON files. Read/write with atomic rename (same pattern as IPC). No database needed — plans are session-scoped and ephemeral.

#### 2.5 IPC bridge

When user acts on a section:
1. Server writes event to `~/myclaw/data/ipc/{groupFolder}/plan-events/{timestamp}.json`
2. Host IPC watcher picks it up
3. Routes to active agent session as an injected message
4. Agent processes feedback, updates plan, writes response
5. Server polls `plan-responses/` or watches for plan file changes
6. SSE pushes update to Mini App

---

### Phase 3: Agent-Side MCP Tools

**Goal:** Give the agent tools to create and manage plans that appear in the Mini App.

#### 3.1 New MCP tools in ipc-mcp-stdio.ts

```typescript
// Create a new plan (agent calls this when entering plan mode)
server.tool('create_plan', {
  title: z.string(),
  sections: z.array(z.object({
    title: z.string(),
    content: z.string(),
  })),
});
// Returns: { planId: string, url: string }
// url = Mini App deep link for this plan

// Update a specific section
server.tool('update_plan_section', {
  planId: z.string(),
  sectionIndex: z.number(),
  content: z.string().optional(),
  status: z.enum(['pending', 'executing', 'done']).optional(),
});

// Wait for user feedback on the plan (blocks until user acts)
server.tool('wait_for_plan_feedback', {
  planId: z.string(),
  timeout: z.number().optional(), // ms, default 300000 (5 min)
});
// Returns: PlanEvent[] — all user actions since last check

// Get current plan state
server.tool('get_plan', {
  planId: z.string(),
});
// Returns: Plan
```

#### 3.2 Telegram notification

When agent creates a plan, MyClaw sends a Telegram message with a Mini App launch button:

```typescript
const appUrl = `https://app.myclaw.dev/plans/${plan.id}?api=${encodeURIComponent(MINI_APP_API_URL)}`;

await bot.api.sendMessage(chatId, `📋 *${plan.title}*\n\n${plan.sections.length} sections ready for review.`, {
  parse_mode: 'MarkdownV2',
  reply_markup: {
    inline_keyboard: [[
      {
        text: '📋 Review Plan',
        web_app: { url: appUrl }
      }
    ]]
  }
});
```

---

### Phase 4: Mini App UI Implementation

**Goal:** Build the actual React UI pages and components.

#### 4.1 Plan View Page (`PlanView.tsx`)

Layout:
```
┌────────────────────────────────┐
│ ← Back        Plan Title    ⋮ │  (Telegram header)
├────────────────────────────────┤
│ ▓▓▓▓▓▓▓▓░░░░░  3/7 approved   │  (progress bar)
├────────────────────────────────┤
│                                │
│ ┌────────────────────────────┐ │
│ │ ✅ 1. Extend IPC          │ │  (approved, collapsed)
│ └────────────────────────────┘ │
│ ┌────────────────────────────┐ │
│ │ ⏳ 2. Callback Routing     │ │  (reviewing, expanded)
│ │                            │ │
│ │ Generalize the callback    │ │
│ │ handler to route non-perm  │ │
│ │ callbacks to active agent  │ │
│ │                            │ │
│ │ [✅ Approve] [❌ Reject]   │ │
│ │ [✏️ Suggest Edit]          │ │
│ └────────────────────────────┘ │
│ ┌────────────────────────────┐ │
│ │ ⬜ 3. MCP Tools            │ │  (pending, collapsed)
│ └────────────────────────────┘ │
│                                │
├────────────────────────────────┤
│ [✅ Approve All] [❌ Reject]   │  (sticky footer)
└────────────────────────────────┘
```

Features:
- Expandable/collapsible sections (tap to toggle)
- Status badges: ✅ approved, ❌ rejected, ⏳ reviewing, ✏️ editing, ⬜ pending
- Haptic feedback on button taps (via TMA SDK)
- Telegram theme integration (dark/light mode automatic)
- Back button wired to Telegram's native back
- Pull-to-refresh for plan updates
- Real-time SSE updates (section statuses animate in)

#### 4.2 Inline Editor (`InlineEditor.tsx`)

When user taps "Suggest Edit":
- Section expands to show a textarea pre-filled with current content
- User edits and taps "Submit"
- Haptic feedback on submit
- Section shows "Waiting for agent revision..." status
- Agent receives edit, revises, pushes update via SSE
- Section updates with revised content + diff highlight

#### 4.3 Plan List Page (`Home.tsx`)

If multiple plans exist (rare but possible):
- List of plans with title, status, progress
- Tap to open PlanView
- Most recent plan auto-opens if only one exists

---

### Phase 5: Telegram Bot Integration

**Goal:** Wire the Mini App into the existing Telegram channel.

#### 5.1 Bot Menu Button

Set the bot's menu button to open the Mini App:

```typescript
await bot.api.setChatMenuButton({
  menu_button: {
    type: 'web_app',
    text: 'Plans',
    web_app: { url: MINI_APP_URL }
  }
});
```

This adds a persistent "Plans" button next to the message input.

#### 5.2 Inline keyboard launch

When agent creates a plan, send inline keyboard with `web_app` button (see Phase 3.2).

#### 5.3 Callback query for quick actions

For simple approve/reject without opening the Mini App, also send inline keyboard buttons:

```
📋 Section 2: Callback Routing
[✅ Quick Approve] [📋 Open in App]
```

Quick approve uses existing callback_query pattern. "Open in App" uses web_app button.

#### 5.4 Notification when plan needs attention

If agent is waiting for feedback and user hasn't acted in 2 minutes:

```
⏳ Plan "Telegram Mini App" is waiting for your review.
3/7 sections reviewed. [📋 Continue Review]
```

---

### Phase 6: Hosting & Deployment

**Goal:** Two things to host: the React frontend (centrally) and the API server (per-user).

#### Frontend: Centrally hosted (zero setup for users)

Deploy the React build as a static site:

```
app.myclaw.dev → Cloudflare Pages / Vercel (free tier)
```

- Auto-deploys from `apps/mini-app/` on push to main
- All MyClaw users share the same frontend URL
- UI updates ship independently of MyClaw npm releases
- No hosting burden on users

#### API: Per-user MyClaw process

The Fastify API server (Phase 2) runs inside each user's MyClaw process on port 3100. Users expose it via:

| Method | When |
|--------|------|
| **Cloudflare Tunnel** | Mac / home server (free, no port forwarding) |
| **Caddy reverse proxy** | VPS with a domain |
| **ngrok** | Quick dev testing |

```bash
# One-time setup
cloudflared tunnel create myclaw-api
cloudflared tunnel --url http://localhost:3100
# → https://myclaw-api-xyz.trycloudflare.com
```

The tunnel URL is stored in MyClaw config as `MINI_APP_API_URL`. The bot passes it when launching the Mini App:

```typescript
web_app: { url: `https://app.myclaw.dev/plans/${planId}?api=${encodeURIComponent(apiUrl)}` }
```

MyClaw's setup flow can automate tunnel creation: detect `cloudflared`, create tunnel, store URL.

#### Development: Vite dev server

During Mini App frontend development:

```bash
cd apps/mini-app && npm run dev     # https://localhost:5173
# Open in browser or use BotFather test environment
```

---

## Implementation Order

| # | Task | Depends On | Effort |
|---|------|------------|--------|
| 1 | Scaffold `apps/mini-app/` from reactjs-template | — | 2h |
| 2 | Plan data model + JSON store | — | 2h |
| 3 | Mini App server (Fastify, auth, plan CRUD) | 2 | 4h |
| 4 | IPC bridge (plan-events, plan-responses) | 2, 3 | 4h |
| 5 | Agent MCP tools (create_plan, update, wait) | 4 | 4h |
| 6 | Telegram bot integration (web_app button, menu) | 3 | 2h |
| 7 | PlanView page + PlanSection component | 1 | 4h |
| 8 | Section actions (approve/reject/edit) | 3, 7 | 3h |
| 9 | Inline editor | 8 | 3h |
| 10 | SSE streaming for real-time updates | 3 | 3h |
| 11 | Theme integration + TelegramUI styling | 1 | 2h |
| 12 | Quick approve via inline keyboard (no Mini App) | 6 | 2h |
| 13 | Tunnel/hosting setup | 3 | 1h |
| 14 | End-to-end testing | All | 4h |

**Total estimated:** ~40 hours (~1 week focused work with agentic coding)

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Mini App needs HTTPS with valid cert | Blocks development | Use cloudflared tunnel or vite-plugin-mkcert |
| Telegram caches Mini App aggressively | Stale UI after deploy | Version the URL with query param, use `Telegram.WebApp.disableVerticalSwipes()` |
| SSE drops when app backgrounded | Missed updates | Reconnect on `visibilitychange` event, fetch full state on reconnect |
| Plan state lost on restart | Data loss | Write to disk (JSON), load on startup |
| initData expires (hash valid for limited time) | Auth failures | Re-launch Mini App for fresh initData, or use session tokens |
| 64-byte callback_data limit | Can't encode complex data in buttons | Use short IDs, lookup full data server-side |

## Future Extensions

- **Execution view:** Watch agent execute approved plan in real-time (streaming output per section)
- **Diff view:** Show before/after when agent revises a section
- **History:** Browse past plans and their outcomes
- **Multi-user review:** Multiple admins can approve sections, see who approved what
- **Plan templates:** Pre-built plan structures for common tasks
- **Voice notes:** User can send voice feedback on a section (Telegram voice message → transcription → edit suggestion)
