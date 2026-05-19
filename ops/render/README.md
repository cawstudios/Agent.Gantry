# Render Free Plan Settings Bootstrap

Render free web services do not provide persistent disks. Gantry still needs a
runtime `settings.yaml`, so this deployment path renders the file from
non-secret Render environment variables on every start.

Use this start command:

```sh
node ops/render/write-settings.mjs && GANTRY_CONTROL_PORT=$PORT npm start
```

Keep secrets such as database URLs, Slack tokens, and encryption keys in Render
environment variables. The variables below are non-secret runtime settings used
to write `$GANTRY_HOME/settings.yaml`:

```env
GANTRY_RENDER_ONECLI_URL=http://<onecli-private-hostname>:10254
GANTRY_RENDER_SLACK_CHANNEL_ID=C1234567890
GANTRY_RENDER_SLACK_CHANNEL_NAME=agent-gantry-test
GANTRY_RENDER_SLACK_APPROVER_IDS=U1234567890,U0987654321
GANTRY_RENDER_AGENT_NAME=Gantry
GANTRY_RENDER_MODEL=kimi
GANTRY_RENDER_SLACK_TRIGGER=@Gantry
GANTRY_RENDER_REQUIRES_TRIGGER=false
```

The script writes to `$GANTRY_HOME/settings.yaml` unless
`GANTRY_RENDER_SETTINGS_PATH` is set.
