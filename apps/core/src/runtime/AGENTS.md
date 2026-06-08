# Runtime Notes

- Live provider text deltas may contain only whitespace or leading whitespace.
  Runtime streaming must preserve those deltas until the channel stream buffer
  formats the complete visible text.
- The Claude CLI remote-control path was removed. Do not reintroduce direct
  provider-specific remote-control spawning in runtime; any future equivalent
  must be a provider-neutral application capability with explicit permission
  and adapter ownership.
- Prepared execution adapters may pass only narrowly allowlisted runner context
  through `agent-spawn`: provider config/model hints plus host-derived skill
  action metadata. IPC auth tokens, MCP paths, provider credentials, arbitrary
  caller env, and other authority-bearing env must stay host-owned or in the
  model credential runner-input lane.
- Runtime sandbox projection must keep read and write protections separate.
  Generated skill projections and reviewed local CLI credential paths may need
  read access for approved executions, but must remain write-protected.
- Reviewer-authorized memory review runs must bind live continuations to the
  same non-self sender that earned control-approver authority. Do not pipe mixed
  or different-sender channel batches into a run that has memory review decision
  tools available.
- Egress gateway socket resets are tunnel-level failures, not host-runtime
  failures. Every accepted client, direct upstream, and upstream-proxy socket
  must have an error listener before piping so routine `ECONNRESET` events do
  not escape as uncaught exceptions and trigger launchd restarts.
- Thread/topic ids on live permission prompts are routing scope. Persisted
  `Always allow` grants and selected capability runtime projection must use the
  parent conversation identity. Thread/topic ids may choose approval delivery
  and audit metadata, but must not create another permission scope.
- Generated `.llm-runtime` access failures are adapter-state failures. Surface
  actionable `.llm-runtime` guidance instead of returning raw `EACCES` as a
  generic runner-exited error.
- Shared runtime accepts Gantry-owned `toolPolicyRules` and neutral
  `providerSession` output. Provider-native names such as Claude SDK
  `allowedTools` and stale provider-session error strings belong behind the
  execution adapter boundary.
