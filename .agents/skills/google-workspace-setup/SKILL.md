---
name: google-workspace-setup
description: |
  Set up, repair, or broaden Google Workspace CLI (`gws`) OAuth access for MyClaw agents. Use when a user mentions `gws auth`, Google Workspace permissions, Gmail/Drive/Sheets/Calendar/Docs access, new-machine setup, `auth_method: "none"`, `Access denied. No credentials provided`, keyring/file backend mismatch, or wants an easy repeatable setup for MyClaw agents.
---

# Google Workspace Setup

Use this skill to make `gws` work from both the human shell and spawned MyClaw agent Bash sessions.

## Goal

Make setup repeatable on any machine:

1. `gws` is installed and in `PATH`.
2. `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file` is set for the runtime and shell.
3. `SSL_CERT_FILE` points at a CA bundle when the host cannot read native root certificates.
4. OAuth login is run with the same file backend that agents use.
5. `gws auth status` shows `auth_method: "oauth2"`, `keyring_backend: "file"`, and `token_valid: true`.
6. A service readiness check succeeds before claiming the agent has access.

## Quick Workflow

Run the bundled helper first:

```bash
.agents/skills/google-workspace-setup/scripts/gws_setup_check.sh
```

If the backend is not file-backed, configure it:

```bash
.agents/skills/google-workspace-setup/scripts/gws_setup_check.sh --write-env
```

Then authenticate with the services the user wants:

```bash
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws auth login --services gmail,drive,sheets,calendar,docs,slides,forms
```

For broader access, use:

```bash
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws auth login --full
```

Use `--full` only when the user explicitly wants broad Google Workspace and Cloud scopes.

Verify after login:

```bash
.agents/skills/google-workspace-setup/scripts/gws_setup_check.sh --verify
```

Restart MyClaw after changing env or auth:

```bash
myclaw restart
```

If the CLI is not installed as a service, stop the running Node runtime and start it again.

## Permission Choices

Choose the narrowest mode that satisfies the user:

- Gmail only: `gws auth login --services gmail`
- Common Workspace agent: `gws auth login --services gmail,drive,sheets,calendar,docs`
- Workspace content creation: `gws auth login --services gmail,drive,sheets,calendar,docs,slides,forms`
- Read-only inspection: `gws auth login --readonly --services gmail,drive,sheets,calendar,docs`
- Broad admin/dev setup: `gws auth login --full`
- Exact custom scopes: `gws auth login --scopes <comma-separated-oauth-scopes>`

If the user says "more permissions" but does not specify exact services, recommend:

```bash
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws auth login --services gmail,drive,sheets,calendar,docs,slides,forms
```

Explain that the user can re-run OAuth later with `--full` if they need admin, pubsub, or cloud-platform scopes.

## Common Failure Fixes

### `auth_method: "none"`

Cause: credentials are missing for the backend currently used by the shell.

Fix:

```bash
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws auth login --services gmail,drive,sheets,calendar,docs
```

### Human terminal works but agent Bash fails

Cause: login used the OS keyring, but spawned agents use file-backed auth.

Fix:

```bash
.agents/skills/google-workspace-setup/scripts/gws_setup_check.sh --write-env
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws auth login --services gmail,drive,sheets,calendar,docs
```

Then restart MyClaw.

### OAuth command is still waiting

Find and stop stale login processes before starting a new one:

```bash
pgrep -af "gws auth login"
kill <pid>
```

Do not kill unrelated processes.

## Validation Commands

Always verify auth before telling the user the agent can use Google Workspace:

```bash
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws auth status
```

If `gws` reports `no native root CA certificates found`, set a CA bundle before retrying:

```bash
export SSL_CERT_FILE=/etc/ssl/cert.pem
```

The helper auto-detects common macOS CA bundle paths and writes `SSL_CERT_FILE` during `--write-env`.

For Gmail:

```bash
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws gmail users getProfile --params '{"userId":"me"}'
```

For Drive:

```bash
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws drive files list --params '{"pageSize":1}'
```

For Sheets, schema availability is a lightweight check:

```bash
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws schema sheets.spreadsheets.get
```

## Safety Rules

- Do not log out existing `gws` auth unless the user explicitly asks.
- Do not use `--full` silently; call out that it grants broad scopes.
- Do not claim Gmail, Drive, or Sheets access until a command succeeds.
- Prefer file backend for MyClaw because agent sessions and terminal sessions can share it.
- Keep secrets out of repo files. The runtime `.env` should contain only the backend setting, not OAuth tokens.
