import { describe, expect, it } from 'vitest';

import {
  jobCompletedModelPayload,
  jobStartedModelPayload,
  modelUseKindForJobSchedule,
  resolveJobExecutionProviderId,
  resolveJobModel,
} from '@core/jobs/model-resolution.js';

describe('job model resolution', () => {
  it('maps manual and once jobs to one-time defaults', () => {
    expect(modelUseKindForJobSchedule('manual')).toBe('oneTimeJob');
    expect(modelUseKindForJobSchedule('once')).toBe('oneTimeJob');
    expect(modelUseKindForJobSchedule('cron')).toBe('recurringJob');
    expect(modelUseKindForJobSchedule('interval')).toBe('recurringJob');
  });

  it('uses explicit job model and emits audit payload details', () => {
    const resolved = resolveJobModel(
      { model: 'sonnet', schedule_type: 'manual' } as never,
      { model: 'opus', source: 'system default' },
    );

    expect(resolved).toMatchObject({
      selectedModel: 'sonnet',
      source: 'job.model',
      entry: {
        recommendedAlias: 'sonnet',
      },
    });
    expect(jobStartedModelPayload(resolved)).toMatchObject({
      resolved_model_alias: 'sonnet',
      resolved_model_profile_id: 'anthropic:sonnet-4.6',
      model_source: 'job.model',
      cache_policy: 'anthropic-prompt',
      context_window_tokens: 1000000,
    });
  });

  it('falls back to default config and carries usage into completion audit', () => {
    const resolved = resolveJobModel(
      { model: null, schedule_type: 'manual' } as never,
      {
        model: 'haiku',
        source: 'settings.yaml agent.one_time_job_default_model',
      },
    );
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      totalBillableInputTokens: 12,
      cacheProvider: 'anthropic',
      cacheStatus: 'hit',
      at: '2026-05-01T00:00:00.000Z',
    } as const;

    expect(jobCompletedModelPayload(resolved, usage)).toMatchObject({
      usage,
      resolved_model_alias: 'haiku',
      model_source: 'settings.yaml agent.one_time_job_default_model',
      cache_policy: 'anthropic-prompt',
    });
  });

  it('inherits the bound agent engine when resolving the job execution provider', () => {
    const anthropicSdk = resolveJobModel(
      { model: 'opus', schedule_type: 'manual' } as never,
      { model: 'opus', source: 'system default' },
      'anthropic_sdk',
    );
    const deepagents = resolveJobModel(
      { model: 'opus', schedule_type: 'manual' } as never,
      { model: 'opus', source: 'system default' },
      'deepagents',
    );

    expect(resolveJobExecutionProviderId({ resolvedModel: anthropicSdk })).toBe(
      'anthropic:claude-agent-sdk',
    );
    expect(resolveJobExecutionProviderId({ resolvedModel: deepagents })).toBe(
      'deepagents:langchain',
    );
  });
});
