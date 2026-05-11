# Browser Adapter Guidance

## Local Lessons

- Do not leak raw backend tab indices. Browser tab listings expose stable
  0-based visible tab indices after filtering internal Chrome targets, and
  select/close requests translate those visible indices to backend indices
  inside the adapter. Numeric select/close must fail closed when that mapping
  is missing or stale. Backend-specific output compatibility, such as
  Playwright MCP markdown tab lists, belongs in a clearly named provider
  compatibility helper before the neutral tab projection consumes it.
- Treat Chrome internal targets by both URL and title. Omnibox popups can
  surface with a non-`chrome://` URL but title `Omnibox Popup`.
- `timeout_ms` must reach both budgets: the signed IPC/backend call timeout and
  the private Playwright MCP action budget. Keep backend process identity
  stable across per-call timeout changes; use a stable backend max/default
  action timeout and pass the clamped request timeout to `callTool`. The
  runner-facing browser MCP tools should default omitted `timeout_ms` to the
  same max/default budget so the signed IPC deadline cannot cut off the backend
  before Playwright's retry loop finishes.
- Tab-set mutations such as `browser_tabs` close and new make any previous
  visible-index mapping stale unless the backend returns a fresh structured
  tab list that replaces the mapping.
- Headed pointer and screenshot actions should foreground the selected page
  immediately before backend dispatch with CDP `Target.activateTarget` plus
  page-level `Page.bringToFront`; target setup done earlier in the request is
  not enough for reliable headed Chrome interaction.
- Browser launch must set a nonzero initial page viewport through the
  Playwright MCP backend. A 0x0 inner viewport makes Playwright report every
  target outside the viewport and causes click, hover, and screenshot failures
  downstream.
- Agent-facing browser launch is visible by default and must not expose a
  headless option. Any non-visible mode is an internal test harness detail, not
  a durable setting or browser tool argument.
- Persisted browser-session adoption must reject non-visible Chrome processes.
  Check the owned process command line for `--headless*` before adopting a
  stale CDP session, and relaunch visible Chrome instead.
- Browser usage enforcement must never block `browser_status`,
  `browser_launch`, or `browser_close`; those operations are observability and
  cleanup boundaries, not site-driving actions.
- Browser IPC authorization must be checked before usage settings lookup,
  active-tab resolution, backend dispatch, or usage metering. A stale signed
  request after Browser revocation must not consume per-site buckets.
- Browser usage enforcement for URL-less page actions must use the backend's
  current tab list, not the last explicit `browser_navigate` payload or the
  first CDP target. In-page redirects, cross-site clicks, and multi-tab
  selection can otherwise bypass owner-defined per-site overrides.
- In enforce mode, a backend current-tab URL must normalize to a site before
  metering. Internal or local URLs such as `about:blank`, `chrome://...`, or
  `file://...` must fail closed instead of falling back to stale remembered
  site state.
- `browser_resize` viewport ownership belongs to the Playwright MCP backend.
  Do not split viewport state between sidecar CDP `Browser.setWindowBounds`
  calls and backend `page.setViewportSize`; explicit resize should stay
  backend-native across internal browser modes.
- `browser_take_screenshot` should dispatch directly to the Playwright MCP
  screenshot tool. Do not auto-resize before screenshots; screenshot failures
  should reset the cached backend instead of trying to repair page state in the
  runtime wrapper.
- Headed Playwright MCP backends must start with an explicit
  `--viewport-size`. The bundled backend defaults headed shared-browser
  contexts to `viewport: null` unless configured, so late CDP window sizing or
  late `browser_resize` calls can still let the first page/screenshot observe a
  0x0 or unusably tiny viewport.
- `browser_file_upload` should accept inline file content and materialize it
  under the run artifact root. Requiring agents to pre-create files there is
  not usable from restricted tool sandboxes.
- Check browser readiness before materializing inline upload files. A timed-out
  or unhealthy browser action must not leave background-created files behind.
  Inline uploads need bounded file count, per-file bytes, total bytes, and plain
  filenames only.
- Inline upload materialization must use collision-safe per-request paths.
  Duplicate filenames in one request, same-name concurrent requests, and
  existing files under `uploads/` must not overwrite or alias each other.
- Keep artifact path policy separate from provider argument compatibility.
  File confinement is MyClaw-owned safety policy; Playwright MCP field-shape
  enrichment is backend projection.
- Text-only backend tab lists are not trusted UI state unless the compatibility
  layer can parse them into adapter-owned tab metadata. Unparseable tab lists
  must fail closed and clear stale visible-index mappings.
- Playwright MCP tab lists render as Markdown links such as
  `- 0: (current) [Title](https://example.test/)`. Keep that backend-specific
  shape in the compatibility parser, then feed only structured tab metadata to
  the neutral visible-index projection.
- Treat an unhealthy tool-capability broker as a non-driveable browser status
  for agent tools. Reporting `cdpReady: true` while the credential broker is
  down is misleading because backend browser actions still cannot run.
- Browser deadline and artifact timestamp code should use the shared
  datetime helpers (`nowMs`/`nowIso`) instead of direct `Date.now()` or
  `new Date()` current-time reads so runtime timeout behavior stays
  deterministic under fake clocks and future clock injection.
