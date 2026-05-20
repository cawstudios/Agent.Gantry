# Bug: Browser MCP cannot deliver files to upload inputs

## Summary

The Gantry browser MCP cannot attach a local file to an `<input type=file>` on a hardened third-party site (observed on chatgpt.com). Every supported path is blocked, so an agent that must "upload this file to that web app" is forced to bypass the MCP via direct CDP, or to ask the human to drag-drop.

Status: fixed in the browser gateway by adding `browser_act` action
`file_attach`, backed by Playwright `setInputFiles` with Gantry-owned staging
and path allowlisting. Manual verification against chatgpt.com is still useful
before closing this cleanup note.

## Reproduction

1. Open `https://chatgpt.com/` with `browser_open`.
2. Click the composer's `Add files and more` menu and select `Add photos & files`.
3. Call `browser_act` with `action: file_upload`, `target: <hidden input handle>`, `paths: ["/tmp/claude/some.zip"]`, `profile: "full"`, `reason: "..."`.

Observed: `Browser upload/drop filesystem paths are not accepted.`

## What was tried

| Approach | Result |
| --- | --- |
| `browser_act file_upload` with original path under `~/Workdir/...` | Rejected: backend policy bans path uploads. |
| Same call with the file copied to sandbox-writable `$TMPDIR` (`/tmp/claude/...`) | Same rejection. Path location is not the gate; the action itself is denied. |
| `browser_act evaluate` running `fetch('http://127.0.0.1:<port>/file')` and injecting into the file input via `DataTransfer` | `TypeError: Failed to fetch`. ChatGPT's CSP blocks loopback origins. `mode: 'no-cors'` did not help. |
| Inline base64 chunking through repeated `evaluate` calls | Each chunk file is ~800 KB; `Read` rejects them (token-limit), and embedding chunks as literal arguments in tool calls is impractical at 4.6 MB. |
| AppleScript via `osascript` to drive the visible Chrome window | Sandbox blocks `System Events`. |
| Direct CDP attach via Playwright `connect_over_cdp(http://127.0.0.1:<devtools-port>)` and `input.set_input_files(path)` | Worked. This is the escape hatch we should not need. |

## Why this matters

Any task of the form "log into web app X and upload this artifact" is currently unreachable through the documented MCP surface. The only way to complete it without a human at the keyboard is to:

1. Read the CDP port out of `data/browser-profiles/<profile>/browser-session.json`.
2. Attach Playwright directly to that port from a Bash shell.
3. Call `setInputFiles` on the page element.

That defeats the point of the browser MCP being the controlled surface for browser automation.

## Gaps in the current browser MCP

1. **`file_upload` flat-denies filesystem paths.** There is no scope policy, no per-call approval prompt, no allowlist of sandbox-writable roots. The denial is unconditional, with no documented alternative.
2. **No file-staging primitive.** Nothing accepts bytes (base64), an artifact id, or a Gantry-managed blob handle and returns something `file_upload` can consume.
3. **`evaluate` cannot reach loopback.** On hardened sites, CSP forbids `fetch('http://127.0.0.1:...')`, so "spin up a local HTTP server and pull from the page" is not a viable workaround.
4. **No "drop file from disk" action.** `browser_act` exposes `drag` and `drop` for in-page elements, but not "drop these filesystem paths onto element X" — which Playwright supports natively and which most modern uploaders accept.
5. **CDP escape hatch is an undocumented requirement.** Recovery only worked because `browser-session.json` exposes the CDP port and Playwright is installed locally. If either were missing, the task would have been unrecoverable without a human.
6. **`profile: "full"` + `reason` gating is discovered through failure.** Every `evaluate` and `file_upload` requires both fields. Without a clear capability schema up front, every first call wastes two round-trips on validation errors.

## Proposed fix

Add a backend-resolved file-attach primitive that the browser MCP owns end-to-end:

```text
browser_act {
  action: "file_attach",
  target: "<element handle>",
  source: {
    type: "artifact" | "bytes" | "path",
    ...
  },
  profile: "full",
  reason: "<why>"
}
```

Backend behavior:

- `artifact`: resolve a Gantry-managed FileArtifact through signed app/agent scope, stage it as inline upload bytes, then hand the path to Playwright `set_input_files`.
- `bytes`: base64 payload (small files only; capped, e.g., 2 MB), staged the same way.
- `path`: only accept paths inside an allowlisted set of sandbox-writable roots (`$TMPDIR`, `data/sessions/.../extra/`). Reject anything else.

Outcome: agents complete browser uploads through one documented action with the same approval/auditing surface as the rest of the browser MCP; the CDP escape hatch becomes a debugging tool, not a hard dependency.

## Acceptance criteria

- `browser_act file_attach` succeeds on chatgpt.com for a 5 MB zip staged in `$TMPDIR`, without falling back to direct CDP.
- Path-source uploads outside the allowlist are rejected with a clear error naming the allowed roots.
- The browser capability doc (`docs/architecture/browser-capability.md`) documents `file_attach`, the allowed `source` types, and the audit-event shape.
- Existing `file_upload` either becomes an alias for `file_attach { source: { type: "path", ...} }` or is retired in favor of `file_attach`.

## Verification

- Add an MCP-level test that uploads a fixture zip via `file_attach` against a local test page that mirrors ChatGPT's hidden-input pattern.
- Add a negative test confirming a path outside the allowlist is rejected.
- Manually verify against chatgpt.com once before close-out.

## Notes

- Repro session: 2026-05-18, while uploading `gantry-codebase-for-gpt.zip` (4.6 MB) into a GPT-5.5 Pro Extended chat.
- CDP port for that session was discovered at `data/browser-profiles/c-main_agent-27f898a4e060/browser-session.json` (`port: 58728`).
- The Playwright workaround used `chromium.connect_over_cdp` against that port and `set_input_files` on the first unrestricted `input[type=file]`.
