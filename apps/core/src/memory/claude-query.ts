import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  EXTERNAL_BROKER_BASE_URL,
  MYCLAW_CREDENTIAL_MODE,
  ONECLI_BROKER_URL,
  type ClaudeAuthMode,
} from '../config/index.js';
import { envConfig } from '../config/env/index.js';
import {
  createAgentCredentialBroker,
  getAgentCredentialInjection,
} from '../application/credentials/agent-credential-service.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import { AGENT_CREDENTIAL_ENV_KEYS } from '../config/source-classification.js';

export interface ClaudeQueryOpts {
  model: string;
  prompt: string;
  systemPrompt?: string;
  userBlocks?: Array<{
    text: string;
    cacheStatic?: boolean;
  }>;
  onUsage?: (usage: ClaudeUsage) => void;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeAuthAvailability {
  hasOauthToken: boolean;
  hasApiKey: boolean;
  mode: ClaudeAuthMode;
}

let memoryCredentialBrokerPromise:
  | Promise<AgentCredentialBroker | undefined>
  | undefined;

export function getClaudeAuthAvailability(): ClaudeAuthAvailability {
  return {
    hasOauthToken: false,
    hasApiKey: false,
    mode:
      (MYCLAW_CREDENTIAL_MODE === 'onecli' && ONECLI_BROKER_URL.trim()) ||
      (MYCLAW_CREDENTIAL_MODE === 'external' && EXTERNAL_BROKER_BASE_URL.trim())
        ? 'broker'
        : 'none',
  };
}

export function hasClaudeAuthConfigured(): boolean {
  return getClaudeAuthAvailability().mode !== 'none';
}

function readAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const row = message as {
    type?: unknown;
    message?: { content?: unknown };
  };
  if (row.type !== 'assistant') return '';
  const content = row.message?.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      out += typed.text;
    }
  }
  return out;
}

function readResultText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const row = message as { type?: unknown; result?: unknown };
  if (row.type !== 'result') return '';
  return typeof row.result === 'string' ? row.result : '';
}

function flattenPrompt(opts: ClaudeQueryOpts): string {
  const parts: string[] = [];
  if (opts.systemPrompt) {
    parts.push(`System:\n${opts.systemPrompt}`);
  }
  if (opts.userBlocks?.length) {
    parts.push(...opts.userBlocks.map((block) => block.text));
  } else {
    parts.push(opts.prompt);
  }
  return parts.join('\n\n');
}

async function resolveOnecliMemoryEnv(): Promise<Record<string, string>> {
  if (MYCLAW_CREDENTIAL_MODE === 'external') {
    const injection = await getAgentCredentialInjection({
      mode: MYCLAW_CREDENTIAL_MODE,
      agentIdentifier: 'memory',
      externalBrokerUrl: EXTERNAL_BROKER_BASE_URL,
      env: envConfig,
    });
    return injection.env;
  }
  if (!ONECLI_BROKER_URL.trim()) {
    throw new Error('OneCLI is not configured for Claude access');
  }
  memoryCredentialBrokerPromise ??= createAgentCredentialBroker({
    mode: MYCLAW_CREDENTIAL_MODE,
    onecliUrl: ONECLI_BROKER_URL,
    env: envConfig,
  });
  const injection = await getAgentCredentialInjection({
    mode: MYCLAW_CREDENTIAL_MODE,
    agentIdentifier: 'memory',
    onecliUrl: ONECLI_BROKER_URL,
    broker: await memoryCredentialBrokerPromise,
    env: envConfig,
  });
  return injection.env;
}

async function runWithOnecli(opts: ClaudeQueryOpts): Promise<string> {
  const brokerEnv = await resolveOnecliMemoryEnv();
  const sdkEnv = scrubAmbientAgentCredentials(brokerEnv);
  const stream = query({
    prompt: flattenPrompt(opts),
    options: {
      model: opts.model,
      maxTurns: 1,
      env: sdkEnv,
    },
  }) as AsyncIterable<unknown>;

  let assistantText = '';
  let resultText = '';

  for await (const message of stream) {
    assistantText += readAssistantText(message);
    if (!resultText) {
      resultText = readResultText(message);
    }
  }

  return (assistantText || resultText).trim();
}

function scrubAmbientAgentCredentials(
  brokerEnv: Record<string, string>,
): Record<string, string> {
  return {
    ...Object.fromEntries(AGENT_CREDENTIAL_ENV_KEYS.map((key) => [key, ''])),
    ...brokerEnv,
  };
}

export async function runClaudeQuery(opts: ClaudeQueryOpts): Promise<string> {
  if (!hasClaudeAuthConfigured()) {
    throw new Error(
      'Claude auth is not configured (configure brokered model access)',
    );
  }
  return runWithOnecli(opts);
}
