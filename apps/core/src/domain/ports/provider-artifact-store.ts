import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type {
  AgentSessionId,
  ProviderSessionId,
} from '../sessions/sessions.js';
import type {
  ProviderSessionArtifact,
  ProviderSessionArtifactId,
  ProviderSessionArtifactKind,
  ProviderSessionArtifactStorageType,
} from '../sessions/provider-session-artifact.js';

export interface PutProviderArtifactInput {
  id?: ProviderSessionArtifactId;
  appId: AppId;
  agentId: AgentId;
  agentSessionId: AgentSessionId;
  providerSessionId: ProviderSessionId;
  provider: string;
  artifactKind: ProviderSessionArtifactKind;
  storageType?: ProviderSessionArtifactStorageType;
  content: Uint8Array | string;
  contentType?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderArtifactListInput {
  appId?: AppId;
  agentId?: AgentId;
  agentSessionId?: AgentSessionId;
  providerSessionId?: ProviderSessionId;
  provider?: string;
  artifactKind?: ProviderSessionArtifactKind;
  includeDeleted?: boolean;
  limit?: number;
}

export interface ProviderArtifactLatestInput {
  agentSessionId?: AgentSessionId;
  providerSessionId?: ProviderSessionId;
  provider?: string;
  artifactKind?: ProviderSessionArtifactKind;
}

export interface ProviderSessionArtifactContext {
  appId: string;
  agentId: string;
  agentSessionId: string;
  provider?: string;
  providerSessionId?: string;
  latestArtifactId?: string;
}

export interface ProviderArtifactStore {
  putArtifact(
    input: PutProviderArtifactInput,
  ): Promise<ProviderSessionArtifact>;
  getArtifact(
    ref: ProviderSessionArtifactId | ProviderSessionArtifact,
  ): Promise<Uint8Array | string>;
  getLatestArtifact(
    input: ProviderArtifactLatestInput,
  ): Promise<ProviderSessionArtifact | undefined>;
  listArtifacts(
    input: ProviderArtifactListInput,
  ): Promise<ProviderSessionArtifact[]>;
  markDeleted(
    ref: ProviderSessionArtifactId | ProviderSessionArtifact,
    deletedAt?: string,
  ): Promise<void>;
  healthCheck?(): Promise<void>;
}
