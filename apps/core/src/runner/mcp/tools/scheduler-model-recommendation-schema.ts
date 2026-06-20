import { z } from 'zod';

import {
  AGENT_HARNESSES,
  type AgentHarness,
} from '../../../shared/agent-engine.js';
import type { ModelWorkload } from '../../../shared/model-catalog.js';

export const schedulerModelRecommendationSchema = {
  workload: z
    .enum([
      'chat',
      'one_time_job',
      'recurring_job',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ])
    .optional(),
  agent_harness: z.enum(AGENT_HARNESSES).optional(),
  estimated_context_tokens: z.number().int().positive().optional(),
  requires_tools: z.boolean().optional(),
  priority: z.enum(['cheap', 'balanced', 'best']).optional(),
  current_alias: z.string().optional(),
};

export type SchedulerModelRecommendationArgs = {
  workload?: ModelWorkload;
  agent_harness?: AgentHarness;
  estimated_context_tokens?: number;
  requires_tools?: boolean;
  priority?: 'cheap' | 'balanced' | 'best';
  current_alias?: string;
};
