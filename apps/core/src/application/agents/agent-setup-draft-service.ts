import type { Agent, AgentId } from '../../domain/agent/agent.js';
import type {
  AgentSetupDraft,
  AgentSetupStage,
} from '../../domain/agent/agent-setup-draft.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentRepository,
  AgentSetupDraftRepository,
} from '../../domain/ports/repositories.js';
import type { Clock } from '../common/clock.js';
import type { IdGenerator } from '../common/id-generator.js';
import { ApplicationError } from '../common/application-error.js';

export class AgentSetupDraftConflictError extends Error {
  constructor() {
    super('This draft changed in another window. Reload it before continuing.');
    this.name = 'AgentSetupDraftConflictError';
  }
}

export class AgentSetupDraftService {
  constructor(
    private readonly deps: {
      agents: AgentRepository;
      drafts: AgentSetupDraftRepository;
      ids: IdGenerator;
      clock: Clock;
      audit?: (input: {
        action: 'created' | 'saved' | 'discarded';
        appId: AppId;
        agentId: AgentId;
      }) => Promise<void>;
    },
  ) {}

  async create(input: {
    appId: AppId;
    name: string;
    purpose?: string;
  }): Promise<{ agent: Agent; draft: AgentSetupDraft }> {
    const now = this.deps.clock.now();
    const agentId = `agent:${this.deps.ids.generate()}` as AgentId;
    const agent: Agent = {
      id: agentId,
      appId: input.appId,
      name: input.name.trim(),
      description: optionalText(input.purpose),
      status: 'disabled',
      createdAt: now,
      updatedAt: now,
    };
    const draft: AgentSetupDraft = {
      appId: input.appId,
      agentId,
      purpose: optionalText(input.purpose),
      currentStage: 'agent',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.agents.saveAgent(agent);
    await this.deps.drafts.saveDraft(draft);
    await this.deps.audit?.({ action: 'created', appId: input.appId, agentId });
    return { agent, draft };
  }

  async get(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<{ agent: Agent; draft: AgentSetupDraft }> {
    const agent = await this.deps.agents.getAgent(input.agentId);
    const draft = await this.deps.drafts.getDraft(input);
    if (!agent || agent.appId !== input.appId || !draft) {
      throw new ApplicationError('NOT_FOUND', 'Agent setup draft not found');
    }
    if (agent.status !== 'disabled') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Agent setup is no longer a draft',
      );
    }
    return { agent, draft };
  }

  async update(input: {
    appId: AppId;
    agentId: AgentId;
    expectedVersion: number;
    patch: {
      name?: string;
      purpose?: string;
      modelAlias?: string;
      connection?: Record<string, unknown>;
      conversation?: Record<string, unknown>;
      currentStage: AgentSetupStage;
    };
  }): Promise<{ agent: Agent; draft: AgentSetupDraft }> {
    const current = await this.get(input);
    if (current.draft.version !== input.expectedVersion) {
      throw new AgentSetupDraftConflictError();
    }
    if (input.patch.connection !== undefined) {
      assertNoRawSecrets(input.patch.connection, 'connection');
    }
    const now = this.deps.clock.now();
    const draft: AgentSetupDraft = {
      ...current.draft,
      ...(input.patch.purpose !== undefined
        ? { purpose: optionalText(input.patch.purpose) }
        : {}),
      ...(input.patch.modelAlias !== undefined
        ? { modelAlias: input.patch.modelAlias.trim() }
        : {}),
      ...(input.patch.connection !== undefined
        ? { connection: input.patch.connection }
        : {}),
      ...(input.patch.conversation !== undefined
        ? { conversation: input.patch.conversation }
        : {}),
      currentStage: input.patch.currentStage,
      version: current.draft.version + 1,
      updatedAt: now,
    };
    const saved = await this.deps.drafts.compareAndSetDraft({
      draft,
      expectedVersion: input.expectedVersion,
    });
    if (!saved) throw new AgentSetupDraftConflictError();
    const agent: Agent = {
      ...current.agent,
      ...(input.patch.name !== undefined
        ? { name: input.patch.name.trim() }
        : {}),
      ...(input.patch.purpose !== undefined
        ? { description: optionalText(input.patch.purpose) }
        : {}),
      updatedAt: now,
    };
    await this.deps.agents.saveAgent(agent);
    await this.deps.audit?.({
      action: 'saved',
      appId: input.appId,
      agentId: input.agentId,
    });
    return { agent, draft: saved };
  }

  async discard(input: { appId: AppId; agentId: AgentId }): Promise<void> {
    await this.get(input);
    const deleted = await this.deps.agents.deleteDisabledAgent(input);
    if (!deleted) throw new AgentSetupDraftConflictError();
    await this.deps.audit?.({
      action: 'discarded',
      appId: input.appId,
      agentId: input.agentId,
    });
  }
}

const SECRET_KEY_PATTERN =
  /(token|secret|password|credential|api[_-]?key|app[_-]?token|bot[_-]?token)/i;

function assertNoRawSecrets(value: unknown, path: string): void {
  if (value === undefined || value === null || typeof value !== 'object')
    return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoRawSecrets(entry, `${path}[${index}]`),
    );
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'runtimeSecretRefs') {
      if (
        !nested ||
        typeof nested !== 'object' ||
        Array.isArray(nested) ||
        Object.values(nested).some((ref) => typeof ref !== 'string')
      ) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `${path}.runtimeSecretRefs must contain only string references.`,
        );
      }
      continue;
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `${path}.${key} looks like a raw secret. Use a stored runtime secret reference instead.`,
      );
    }
    assertNoRawSecrets(nested, `${path}.${key}`);
  }
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
