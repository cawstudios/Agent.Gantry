import { query } from '@anthropic-ai/claude-agent-sdk';
import { OneCLI } from '@onecli-sh/sdk';

import { type ClaudeAuthMode } from '../config/index.js';
import { envValue } from '../config/env/index.js';
import { filterTrustedOnecliEnv } from '../infrastructure/onecli/env-policy.js';
import { assertValidOnecliUrl } from '../infrastructure/onecli/policy.js';

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

function readOnecliUrl(): string {
  return envValue('ONECLI_URL').trim();
}

export function getClaudeAuthAvailability(): ClaudeAuthAvailability {
  const onecliUrl = readOnecliUrl();
  return {
    hasOauthToken: false,
    hasApiKey: false,
    mode: onecliUrl ? 'broker' : 'none',
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
  const onecliUrl = readOnecliUrl();
  if (!onecliUrl) {
    throw new Error('OneCLI is not configured for Claude access');
  }
  const onecli = new OneCLI({ url: assertValidOnecliUrl(onecliUrl) });
  const config = await onecli.getContainerConfig('memory');
  return filterTrustedOnecliEnv(config.env || {}).env;
}

async function runWithOnecli(opts: ClaudeQueryOpts): Promise<string> {
  const brokerEnv = await resolveOnecliMemoryEnv();
  const stream = query({
    prompt: flattenPrompt(opts),
    options: {
      model: opts.model,
      maxTurns: 1,
      env: brokerEnv,
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

export async function runClaudeQuery(opts: ClaudeQueryOpts): Promise<string> {
  if (!readOnecliUrl()) {
    throw new Error(
      'Claude auth is not configured (configure OneCLI for brokered model access)',
    );
  }
  return runWithOnecli(opts);
}
