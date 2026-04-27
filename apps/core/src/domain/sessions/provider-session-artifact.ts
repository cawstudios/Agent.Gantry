import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import type { AgentSessionId, ProviderSessionId } from './sessions.js';

export type ProviderSessionArtifactId = BrandedId<'ProviderSessionArtifactId'>;

export type ProviderSessionArtifactKind =
  | 'claude-jsonl'
  | 'claude-session-index'
  | 'provider-state'
  | 'transcript-export';

export type ProviderSessionArtifactStorageType =
  | 'local-filesystem'
  | 'postgres'
  | 'object-store';

export interface ProviderSessionArtifact {
  id: ProviderSessionArtifactId;
  appId: AppId;
  agentId: AgentId;
  agentSessionId: AgentSessionId;
  providerSessionId: ProviderSessionId;
  provider: string;
  artifactKind: ProviderSessionArtifactKind;
  storageType: ProviderSessionArtifactStorageType;
  storageRef: string;
  contentHash: string;
  sizeBytes: number;
  createdAt: IsoTimestamp;
  metadata: Record<string, unknown>;
  deletedAt?: IsoTimestamp;
}
