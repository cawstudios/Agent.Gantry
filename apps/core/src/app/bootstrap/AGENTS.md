# Channel Wiring Notes

- `sendStreamingChunk` is a transport handoff for incremental provider text.
  Preserve leading, trailing, and whitespace-only chunks; channel-specific
  stream sinks own buffering and final formatting.
- If channel persistence auto-registers a direct conversation, await route
  registration and persistence, then enqueue the exact chat queue immediately.
  Do not couple first-message wakeup to old polling intervals; recovery scans are
  only for missed work, not the steady-state webhook path.
- For already-known inbound direct conversations, enqueue the exact chat queue
  immediately after `storeMessage` succeeds so normal webhook turns do not wait
  for recovery work.
- Optional runtime-owned worker pools belong in bootstrap composition, not in
  `GroupQueue`: construct them only behind their default-off config/capability
  gates, pass them through `GroupProcessingDeps`, reap prior-process orphans
  during startup, and close idle workers during shutdown.
