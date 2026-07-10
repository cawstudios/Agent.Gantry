import {
  formatInlineAgentWorkerOnlyConfigError,
  inlineWorkerOnlyToolRuleLabels,
  isInlineWorkerOnlyToolRule,
  type AgentRuntime,
} from '../../shared/agent-runtime.js';
import { DEEPAGENTS_ENGINE } from '../../shared/agent-engine.js';
import { deriveAgentEngineForProvider } from '../../shared/model-execution-route.js';
import {
  resolveModelSelectionForWorkloadWithFamilies,
  type FamilyOrderOverrides,
} from '../../shared/model-families.js';
import { DEFAULT_SETUP_MODEL_ALIAS } from '../../shared/model-catalog.js';
import { settingsCapabilityIdToToolRule } from './configured-capability-normalization.js';
import type {
  AgentEffort,
  RuntimeConfiguredAgent,
} from './runtime-settings-types.js';

const AGENT_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export {
  formatInlineAgentWorkerOnlyConfigError,
  inlineWorkerOnlyToolRuleLabels,
};

export function parseAgentRuntimeValue(
  raw: unknown,
  pathPrefix: string,
): AgentRuntime {
  if (raw === undefined) return 'worker';
  if (raw === 'worker' || raw === 'inline') return raw;
  throw new Error(`${pathPrefix} must be worker or inline`);
}

export function parseAgentMaxTurnsValue(
  raw: unknown,
  pathPrefix: string,
): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${pathPrefix} must be a positive integer`);
  }
  return raw;
}

export function parseAgentEffortValue(
  raw: unknown,
  pathPrefix: string,
): AgentEffort | undefined {
  if (raw === undefined) return undefined;
  if (!AGENT_EFFORT_VALUES.includes(raw as AgentEffort)) {
    throw new Error(
      `${pathPrefix} must be one of ${AGENT_EFFORT_VALUES.join(', ')}`,
    );
  }
  return raw as AgentEffort;
}

export function resolveConfiguredAgentRuntime(
  agent: Pick<RuntimeConfiguredAgent, 'runtime'> | undefined,
): AgentRuntime {
  return agent?.runtime ?? 'worker';
}

export function inlineWorkerOnlyConfiguredCapabilityLabels(input: {
  agent: RuntimeConfiguredAgent;
  stdioMcpServerIds?: ReadonlySet<string>;
}): string[] {
  if (resolveConfiguredAgentRuntime(input.agent) !== 'inline') return [];
  const labels = new Set<string>();
  for (const source of input.agent.sources.tools) {
    if (source.kind === 'local_cli') labels.add(source.id);
  }
  for (const source of input.agent.sources.mcpServers) {
    if (input.stdioMcpServerIds?.has(source.id)) labels.add(source.id);
  }
  for (const capability of input.agent.capabilities) {
    const rule = settingsCapabilityIdToToolRule(capability.id);
    if (isInlineWorkerOnlyToolRule(rule)) labels.add(capability.id);
  }
  return [...labels].sort();
}

export function inlineConfiguredSkillEngineConstraintError(input: {
  subject: string;
  agent: RuntimeConfiguredAgent;
  defaultModel?: string;
  defaultOneTimeJobDefaultModel?: string;
  defaultRecurringJobDefaultModel?: string;
  modelFamilyOrder?: FamilyOrderOverrides;
}): string | null {
  const skillIds = input.agent.sources.skills.map((source) => source.id);
  if (
    resolveConfiguredAgentRuntime(input.agent) !== 'inline' ||
    skillIds.length === 0
  ) {
    return null;
  }
  const formattedSkillIds = [...new Set(skillIds)].sort().join(', ');
  const selections = [
    {
      model:
        input.agent.model?.trim() ||
        input.defaultModel?.trim() ||
        DEFAULT_SETUP_MODEL_ALIAS,
      workload: 'chat' as const,
    },
    {
      model:
        input.agent.oneTimeJobDefaultModel?.trim() ||
        input.defaultOneTimeJobDefaultModel?.trim(),
      workload: 'one_time_job' as const,
    },
    {
      model:
        input.agent.recurringJobDefaultModel?.trim() ||
        input.defaultRecurringJobDefaultModel?.trim(),
      workload: 'recurring_job' as const,
    },
  ];
  for (const selection of selections) {
    if (!selection.model) continue;
    const resolved = resolveModelSelectionForWorkloadWithFamilies(
      selection.model,
      selection.workload,
      input.modelFamilyOrder,
    );
    if (!resolved.ok) continue;
    const agentEngine = deriveAgentEngineForProvider(
      resolved.entry.modelRoute.id,
    );
    if (agentEngine !== DEEPAGENTS_ENGINE) {
      return `${input.subject}.runtime inline supports attached skills only with engine ${DEEPAGENTS_ENGINE}; model ${selection.model} resolved engine ${agentEngine} is incompatible with attached skills: ${formattedSkillIds}`;
    }
  }
  return null;
}
