# Channel Wiring Notes

- `sendStreamingChunk` is a transport handoff for incremental provider text.
  Preserve leading, trailing, and whitespace-only chunks; channel-specific
  stream sinks own buffering and final formatting.
- If channel persistence auto-registers a direct conversation, schedule a
  deferred first-message queue check after persistence. The polling loop may
  have snapped routes before registration and advanced its global timestamp past
  that message, but an immediate enqueue can race the poll loop and duplicate a
  continuation before the new run advances its cursor.
- For already-known inbound direct conversations, enqueue the exact chat queue
  immediately after `storeMessage` succeeds so normal webhook turns do not wait
  for the poll loop. Keep the auto-registration case on the deferred path above.
- Optional runtime-owned worker pools belong in bootstrap composition, not in
  `GroupQueue`: construct them only behind their default-off config/capability
  gates, pass them through `GroupProcessingDeps`, reap prior-process orphans
  during startup, and close idle workers during shutdown.
