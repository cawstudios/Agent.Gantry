import { z } from 'zod';

export const chatListSearchSchema = z.object({
  q: z.string().catch(''),
  status: z.enum(['all', 'active', 'inactive', 'archived']).catch('all'),
  agent: z.string().catch('all'),
});

export const chatDetailSearchSchema = z.object({
  inspector: z.enum(['thread', 'timeline']).catch('thread'),
});

export const memorySearchSchema = z.object({
  q: z.string().catch(''),
  kind: z
    .enum([
      'all',
      'preference',
      'decision',
      'fact',
      'correction',
      'constraint',
      'reference',
      'procedure',
    ])
    .catch('all'),
  confidence: z.enum(['all', 'high', 'medium', 'low']).catch('all'),
});
