---
status: accepted
confirmed_by: "vrknetha"
date: 2026-07-24
---

# Inbound Attachment Descriptor Writer

## Context

The 2026-07-24 audit found (High) that Telegram and Slack inbound attachment
writes reach `<workspace>/attachments/<filename>` via `writeFile` / `open(...,
'w')` (`channels/telegram-file-download.ts`, `channels/slack/
attachment-download.ts` → `shared/private-fs.ts`), which follow a pre-planted
symlink or lose a check/open race — letting a malicious workspace overwrite
service-account-writable files outside the workspace. The hardened
`platform/workspace-message-attachment.ts` is a read-only resolver: it proves
the descriptor-containment pattern but offers no write path.

## Decision

Build ONE shared hardened inbound-attachment writer (alongside
`apps/core/src/shared/private-fs.ts`) and route every inbound channel through
it: open a collision-resistant temp name with `O_CREAT|O_EXCL|O_NOFOLLOW`
inside a containment-verified directory, validate the opened descriptor
(fstat, containment), stream into the descriptor, then publish atomically
without replacing an existing target. Raw `writeFile`/`'w'` inbound paths are
deleted. Adversarial tests run against the real filesystem — no fs mocks.

## Consequences

- One writer closes the class for all current and future inbound channels;
  per-channel patches were rejected as leaving the class open.
- Second upload of an identical filename no longer silently overwrites
  (no-replace publish) — intended behavior change.
- Real-fs test coverage: pre-existing final-file symlink, swap-during-open,
  ancestor-directory swap, buffered + streaming paths.
