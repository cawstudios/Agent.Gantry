import type { JsonSchema } from './openapi-route-helpers.js';

const cacheControl = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['ephemeral'] },
    ttl: { type: 'string', enum: ['5m', '1h'] },
  },
} as const;

const textBlock = {
  type: 'object',
  required: ['type', 'text'],
  properties: {
    type: { type: 'string', enum: ['text'] },
    text: { type: 'string' },
    cache_control: cacheControl,
  },
} as const;

export const llmOpenApiSchemas: Record<string, JsonSchema> = {
  LlmMessagesCountTokensRequest: {
    type: 'object',
    required: ['model', 'messages'],
    additionalProperties: false,
    properties: {
      model: {
        type: 'string',
        description: 'Registered Gantry model alias.',
      },
      messages: {
        type: 'array',
        maxItems: 100000,
        items: {
          type: 'object',
          required: ['role', 'content'],
          additionalProperties: false,
          properties: {
            role: { type: 'string', enum: ['user', 'assistant', 'system'] },
            content: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'array',
                  items: {
                    oneOf: [
                      textBlock,
                      {
                        type: 'object',
                        required: ['type'],
                        description:
                          'Provider Messages content block such as image, document, tool use, or tool result.',
                        properties: { type: { type: 'string' } },
                        additionalProperties: true,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
      system: {
        oneOf: [{ type: 'string' }, { type: 'array', items: textBlock }],
      },
      tools: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'input_schema'],
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            type: { type: ['string', 'null'], enum: ['custom', null] },
            input_schema: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { type: 'string', enum: ['object'] },
                properties: { type: ['object', 'null'] },
                required: {
                  type: ['array', 'null'],
                  items: { type: 'string' },
                },
              },
              additionalProperties: true,
            },
            cache_control: cacheControl,
            strict: { type: 'boolean' },
            defer_loading: { type: 'boolean' },
          },
        },
      },
      tool_choice: {
        type: 'object',
        required: ['type'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['auto', 'any', 'tool', 'none'] },
          name: { type: 'string' },
          disable_parallel_tool_use: { type: 'boolean' },
        },
      },
      thinking: {
        type: 'object',
        required: ['type'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['enabled', 'disabled', 'adaptive'] },
          budget_tokens: { type: 'integer', minimum: 1024 },
          display: { type: ['string', 'null'], enum: ['summarized', 'omitted', null] }, // prettier-ignore
        },
      },
      cache_control: {
        oneOf: [cacheControl, { type: 'null' }],
      },
      output_config: {
        type: 'object',
        additionalProperties: false,
        properties: {
          effort: {
            type: ['string', 'null'],
            enum: ['low', 'medium', 'high', 'xhigh', 'max', null],
          },
          format: {
            type: ['object', 'null'],
            description: 'Provider JSON output-format schema.',
          },
        },
      },
    },
  },
  LlmMessagesCountTokensResponse: {
    type: 'object',
    required: ['input_tokens'],
    additionalProperties: false,
    properties: {
      input_tokens: { type: 'integer', minimum: 0 },
    },
  },
};
