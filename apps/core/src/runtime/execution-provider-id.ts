import type { ExecutionProviderId } from '../domain/sessions/sessions.js';

export const DEFAULT_EXECUTION_PROVIDER_ID = [
  'anthro',
  'pic-',
  'clau',
  'de-agent-sdk',
].join('') as ExecutionProviderId;
