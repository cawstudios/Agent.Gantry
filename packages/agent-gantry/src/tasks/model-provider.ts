import type {
  AnthropicStructuredModelEffort,
  AnthropicStructuredModelConfig,
  AnthropicStructuredModelTaskPolicy,
  GantryAgentTaskAttachment,
  GantryStructuredModelUsage,
  GantryStructuredModelConfig,
  StructuredJsonModelProvider,
  StructuredJsonModelProviderResult,
} from '../shared/types.js';
import {
  asNonEmptyString,
  asRecord,
  fetchWithTimeout,
  parseJsonRecord,
} from '../shared/helpers.js';

export function resolveStructuredModelProvider(
  config: GantryStructuredModelConfig,
): StructuredJsonModelProvider {
  if (isStructuredJsonModelProvider(config)) {
    return config;
  }
  if (config.provider === 'anthropic') {
    return createAnthropicStructuredModelProvider(config);
  }
  throw new Error('Unsupported Gantry structured model provider.');
}

export function createAnthropicStructuredModelProvider(
  config: AnthropicStructuredModelConfig,
): StructuredJsonModelProvider {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required for Anthropic structured model tasks.',
    );
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1_000, config.timeoutMs ?? 60_000);
  const maxRetries = Math.max(1, config.maxRetries ?? 3);
  const apiVersion = config.apiVersion ?? '2023-06-01';

  return {
    generateJson: async (input) => {
      const taskPolicy = resolveAnthropicTaskPolicy(input.taskType, config);
      const model = taskPolicy.model;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
          const startedAt = Date.now();
          const body = buildAnthropicRequestBody({
            input,
            model,
            maxTokens: taskPolicy.maxTokens,
            temperature: taskPolicy.temperature,
            effort: taskPolicy.effort,
          });
          const response = await fetchWithTimeout(
            fetchImpl,
            'https://api.anthropic.com/v1/messages',
            {
              method: 'POST',
              headers: {
                'anthropic-version': apiVersion,
                'content-type': 'application/json',
                'x-api-key': apiKey,
              },
              body: JSON.stringify(body),
            },
            timeoutMs,
          );
          const payload = (await response.json()) as Record<string, unknown>;
          if (!response.ok) {
            throw buildAnthropicError(response.status, payload);
          }
          const output = parseAnthropicJsonPayload(payload);
          return {
            output,
            modelUsage: readAnthropicModelUsage({
              payload,
              body,
              output,
              model,
              taskType: input.taskType,
              correlationId: input.correlationId ?? null,
              durationMs: Date.now() - startedAt,
            }),
          };
        } catch (error) {
          lastError = error;
          if (attempt === maxRetries) break;
        }
      }
      throw new Error(
        `Anthropic ${input.taskType} failed after ${maxRetries} attempts: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    },
  };
}

interface ResolvedAnthropicTaskPolicy {
  readonly model: string;
  readonly maxTokens: number;
  readonly effort: AnthropicStructuredModelEffort;
  readonly temperature?: number;
}

function isStructuredJsonModelProvider(
  value: GantryStructuredModelConfig,
): value is StructuredJsonModelProvider {
  return (
    typeof (value as StructuredJsonModelProvider).generateJson === 'function'
  );
}

function selectAnthropicModel(
  taskType: string,
  config: AnthropicStructuredModelConfig,
): string {
  return (
    asNonEmptyString(config.taskModels?.[taskType]) ??
    asNonEmptyString(config.model) ??
    asNonEmptyString(config.defaultModel) ??
    'claude-sonnet-4-6'
  );
}

function resolveAnthropicTaskPolicy(
  taskType: string,
  config: AnthropicStructuredModelConfig,
): ResolvedAnthropicTaskPolicy {
  const policy = config.taskPolicies?.[taskType];
  const model =
    asNonEmptyString(policy?.model) ?? selectAnthropicModel(taskType, config);
  return {
    model,
    maxTokens: Math.max(1, policy?.maxTokens ?? config.maxTokens ?? 4096),
    effort: normalizeAnthropicEffort(policy?.effort),
    temperature: policy?.temperature ?? config.temperature,
  };
}

function normalizeAnthropicEffort(
  value: AnthropicStructuredModelTaskPolicy['effort'],
): AnthropicStructuredModelEffort {
  return value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max'
    ? value
    : 'off';
}

function buildAnthropicRequestBody(input: {
  readonly input: Parameters<StructuredJsonModelProvider['generateJson']>[0];
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly effort: AnthropicStructuredModelEffort;
}): Record<string, unknown> {
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...buildAnthropicEffortRequestFields(input.effort),
    system: buildAnthropicSystemPrompt(input.input.instructions),
    messages: [
      {
        role: 'user',
        content: buildAnthropicUserContent(input.input),
      },
    ],
  };
}

function buildAnthropicEffortRequestFields(
  effort: AnthropicStructuredModelEffort,
): Record<string, unknown> {
  if (effort === 'off') return {};
  return {
    thinking: { type: 'adaptive' },
    output_config: { effort },
  };
}

function buildAnthropicSystemPrompt(instructions: string): string {
  return [
    instructions.trim(),
    '',
    'Return exactly one JSON object. Do not include markdown fences, prose, or commentary outside JSON.',
  ].join('\n');
}

type AnthropicUserContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly source: {
        readonly type: 'base64';
        readonly media_type: string;
        readonly data: string;
      };
    };

function buildAnthropicUserContent(
  input: Parameters<StructuredJsonModelProvider['generateJson']>[0],
): AnthropicUserContentBlock[] {
  const prompt = [
    'Task type:',
    input.taskType,
    '',
    'Correlation id:',
    input.correlationId ?? '',
    '',
    'Input JSON:',
    JSON.stringify(input.input),
    '',
    'Output schema JSON:',
    JSON.stringify(input.outputSchema ?? {}),
    '',
    input.attachments?.length
      ? `Attachment metadata JSON:\n${JSON.stringify(
          input.attachments.map((attachment) => ({
            label: attachment.label ?? null,
            mimeType: attachment.mimeType,
            purpose: attachment.purpose ?? null,
            sourceStep: attachment.sourceStep ?? null,
            hasInlineData: Boolean(attachment.base64),
            hasLocalPath: Boolean(attachment.localPath),
          })),
        )}`
      : '',
  ]
    .filter((part) => part !== '')
    .join('\n');
  return [
    { type: 'text', text: prompt },
    ...readInlineImageAttachments(input.attachments).map((attachment) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: attachment.mimeType,
        data: attachment.base64,
      },
    })),
  ];
}

function readInlineImageAttachments(
  attachments: readonly GantryAgentTaskAttachment[] | undefined,
): Array<{ readonly mimeType: string; readonly base64: string }> {
  return (attachments ?? [])
    .filter((attachment) => attachment.mimeType.startsWith('image/'))
    .map((attachment) => ({
      mimeType: attachment.mimeType,
      base64: asNonEmptyString(attachment.base64) ?? '',
    }))
    .filter((attachment) => attachment.base64.length > 0);
}

function buildAnthropicError(
  status: number,
  payload: Record<string, unknown>,
): Error {
  const errorRecord = asRecord(payload.error);
  const message =
    asNonEmptyString(errorRecord?.message) ??
    asNonEmptyString(payload.message) ??
    `Anthropic request failed with HTTP ${status}.`;
  return Object.assign(
    new Error(`Anthropic request failed with HTTP ${status}: ${message}`),
    {
      statusCode: status,
    },
  );
}

function parseAnthropicJsonPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .flatMap((entry) => {
      const record = asRecord(entry);
      return record?.type === 'text'
        ? [asNonEmptyString(record.text) ?? '']
        : [];
    })
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('Anthropic response did not include text content.');
  }
  return parseJsonRecord(stripJsonFence(text));
}

function readAnthropicModelUsage(input: {
  readonly payload: Record<string, unknown>;
  readonly body: Record<string, unknown>;
  readonly output: Record<string, unknown>;
  readonly model: string;
  readonly taskType: string;
  readonly correlationId: string | null;
  readonly durationMs: number;
}): GantryStructuredModelUsage {
  const usage = asRecord(input.payload.usage);
  const inputTokens = readOptionalNumber(usage?.input_tokens);
  const outputTokens = readOptionalNumber(usage?.output_tokens);
  const cachedTokens = readOptionalNumber(usage?.cache_read_input_tokens) ??
    readOptionalNumber(usage?.cache_creation_input_tokens);
  const promptCharCount = JSON.stringify(input.body).length;
  if (inputTokens !== null || outputTokens !== null) {
    return {
      provider: 'anthropic',
      model: input.model,
      taskType: input.taskType,
      correlationId: input.correlationId,
      promptCharCount,
      inputTokens,
      outputTokens,
      totalTokens: addOptionalNumbers(inputTokens, outputTokens),
      cachedTokens,
      durationMs: input.durationMs,
      usageSource: 'provider',
    };
  }
  const outputCharCount = JSON.stringify(input.output).length;
  const estimatedInputTokens = estimateTokensFromChars(promptCharCount);
  const estimatedOutputTokens = estimateTokensFromChars(outputCharCount);
  return {
    provider: 'anthropic',
    model: input.model,
    taskType: input.taskType,
    correlationId: input.correlationId,
    promptCharCount,
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens,
    totalTokens: estimatedInputTokens + estimatedOutputTokens,
    cachedTokens: null,
    durationMs: input.durationMs,
    usageSource: 'estimated',
  };
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function addOptionalNumbers(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function estimateTokensFromChars(charCount: number): number {
  return Math.max(1, Math.ceil(charCount / 4));
}

export function unwrapStructuredJsonModelProviderResult(
  result: StructuredJsonModelProviderResult,
): { readonly output: Record<string, unknown> | string; readonly modelUsage: GantryStructuredModelUsage | null } {
  if (isStructuredModelProviderEnvelope(result)) {
    return {
      output: result.output,
      modelUsage: result.modelUsage ?? null,
    };
  }
  return { output: result, modelUsage: null };
}

function isStructuredModelProviderEnvelope(
  value: StructuredJsonModelProviderResult,
): value is { readonly output: Record<string, unknown> | string; readonly modelUsage?: GantryStructuredModelUsage | null } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'output' in value &&
      'modelUsage' in value,
  );
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}
