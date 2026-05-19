#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function requiredEnv(name) {
  const value = process.env[name]?.trim() || '';
  if (!value) {
    throw new Error(`${name} is required to render Gantry settings.yaml.`);
  }
  return value;
}

function optionalEnv(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

function yamlString(value) {
  return JSON.stringify(value);
}

function yamlStringArray(values) {
  return JSON.stringify(values);
}

function parseCsvEnv(name) {
  return requiredEnv(name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function slackConversationId(raw) {
  return raw.startsWith('sl:') ? raw : `sl:${raw}`;
}

function booleanEnv(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

const gantryHome = requiredEnv('GANTRY_HOME');
const settingsPath =
  process.env.GANTRY_RENDER_SETTINGS_PATH?.trim() ||
  path.join(gantryHome, 'settings.yaml');

const agentName = optionalEnv('GANTRY_RENDER_AGENT_NAME', 'Gantry');
const model = optionalEnv('GANTRY_RENDER_MODEL', 'kimi');
const onecliUrl = requiredEnv('GANTRY_RENDER_ONECLI_URL');
const slackChannelId = slackConversationId(
  requiredEnv('GANTRY_RENDER_SLACK_CHANNEL_ID'),
);
const slackChannelName = optionalEnv(
  'GANTRY_RENDER_SLACK_CHANNEL_NAME',
  slackChannelId,
);
const slackApproverIds = parseCsvEnv('GANTRY_RENDER_SLACK_APPROVER_IDS');
const slackTrigger = optionalEnv(
  'GANTRY_RENDER_SLACK_TRIGGER',
  `@${agentName}`,
);
const requiresTrigger = booleanEnv('GANTRY_RENDER_REQUIRES_TRIGGER', false);

const settings = `defaults:
  name: ${yamlString(agentName)}
  model: ${yamlString(model)}

providers:
  slack:
    enabled: true
    default_connection: slack_default

provider_connections:
  slack_default:
    provider: slack
    label: "Slack Workspace"
    runtime_secret_refs:
      app_token: SLACK_APP_TOKEN
      bot_token: SLACK_BOT_TOKEN

agents:
  main_agent:
    name: ${yamlString(agentName)}
    model: ${yamlString(model)}

conversations:
  render_slack_channel:
    provider: slack
    id: ${yamlString(slackChannelId)}
    type: channel
    display_name: ${yamlString(slackChannelName)}
    sender_policy:
      allow: "*"
      mode: trigger
    control_approvers: ${yamlStringArray(slackApproverIds)}
    agent: main_agent
    trigger: ${yamlString(slackTrigger)}
    requires_trigger: ${requiresTrigger ? 'true' : 'false'}
    model: ${yamlString(model)}

credential_broker:
  mode: onecli
  onecli:
    url: ${yamlString(onecliUrl)}
    postgres:
      url_env: ONECLI_DATABASE_URL
      schema: onecli
  external:
    base_url: ""

storage:
  postgres:
    url_env: GANTRY_DATABASE_URL
    schema: gantry

memory:
  enabled: true
  embeddings:
    enabled: false
    provider: disabled
`;

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, settings);
console.log(`Wrote Gantry settings to ${settingsPath}`);
