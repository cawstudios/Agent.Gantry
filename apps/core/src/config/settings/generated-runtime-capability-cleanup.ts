import type { AppId } from '../../domain/app/app.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type { SkillCatalogItem } from '../../domain/skills/skills.js';
import { skillActionSemanticCapability } from '../../domain/skills/skill-action-permissions.js';
import type { SettingsDesiredStateRepositories } from './desired-state-service-types.js';
import { resolveConfiguredSkillReferences } from './desired-state-skill-references.js';
import type {
  RuntimeConfiguredAgentCapability,
  RuntimeSettings,
} from './runtime-settings-types.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import { canonicalizeDurableSkillActionToolRule } from '../../shared/skill-action-capability-rules.js';

export interface GeneratedRuntimeCapabilityCleanupResult {
  capabilities: RuntimeConfiguredAgentCapability[];
  converted: Array<{ from: string; to: string }>;
  dropped: string[];
}

export function settingsCapabilityIdToToolRule(capabilityId: string): string {
  const id = capabilityId.trim();
  if (id === 'browser.use') return 'Browser';
  if (id.includes('.') && !id.startsWith('RunCommand(')) {
    return `capability:${id}`;
  }
  return id;
}

export function toolRuleToSettingsCapability(
  rule: string,
  version = 'builtin',
): RuntimeConfiguredAgentCapability {
  if (rule === 'Browser') return { id: 'browser.use', version };
  if (rule.startsWith('capability:')) {
    return { id: rule.slice('capability:'.length), version };
  }
  return { id: rule, version };
}

export function skillActionDefinitionsForSkills(
  skills: readonly SkillCatalogItem[],
): SemanticCapabilityDefinition[] {
  return skills.flatMap((skill) => {
    if (!skill.storage?.contentHash || !skill.version) return [];
    return (skill.actionPermissions ?? []).map((action) =>
      skillActionSemanticCapability({
        skillId: String(skill.id),
        skillName: skill.name,
        skillVersion: skill.version,
        skillContentHash: skill.storage!.contentHash,
        action,
      }),
    );
  });
}

export function semanticCapabilityDefinitionsById(
  definitions: readonly SemanticCapabilityDefinition[],
): Record<string, SemanticCapabilityDefinition> {
  return Object.fromEntries(
    definitions.map((definition) => [definition.capabilityId, definition]),
  );
}

export function cleanupGeneratedRuntimeCapabilities(input: {
  capabilities: readonly RuntimeConfiguredAgentCapability[];
  skillActionDefinitions?: readonly SemanticCapabilityDefinition[];
}): GeneratedRuntimeCapabilityCleanupResult {
  const capabilities: RuntimeConfiguredAgentCapability[] = [];
  const converted: Array<{ from: string; to: string }> = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  const append = (capability: RuntimeConfiguredAgentCapability) => {
    const key = `${capability.id}\0${capability.version}`;
    if (seen.has(key)) return;
    seen.add(key);
    capabilities.push(capability);
  };

  for (const capability of input.capabilities) {
    const readable = settingsCapabilityIdToToolRule(capability.id);
    const canonical = canonicalizeDurableSkillActionToolRule(readable, {
      semanticCapabilityDefinitions: input.skillActionDefinitions,
      dropGeneratedWithoutMatch: true,
    });
    if (!canonical) {
      dropped.push(capability.id);
      continue;
    }
    const next = toolRuleToSettingsCapability(canonical, capability.version);
    append(next);
    if (next.id !== capability.id) {
      converted.push({
        from: capability.id,
        to: next.id,
      });
    }
  }

  return { capabilities, converted, dropped };
}

export async function cleanupGeneratedRuntimeCapabilitiesInSettings(input: {
  settings: RuntimeSettings;
  repositories: SettingsDesiredStateRepositories;
  appId: AppId;
}): Promise<{
  settings: RuntimeSettings;
  changed: boolean;
  converted: Array<{ agentFolder: string; from: string; to: string }>;
  dropped: Array<{ agentFolder: string; rule: string }>;
}> {
  let nextSettings: RuntimeSettings | undefined;
  const converted: Array<{ agentFolder: string; from: string; to: string }> =
    [];
  const dropped: Array<{ agentFolder: string; rule: string }> = [];

  for (const [folder, agent] of Object.entries(input.settings.agents)) {
    const resolvedSkills = await resolveConfiguredSkillReferences({
      repository: input.repositories.skills,
      appId: input.appId,
      agentId: `agent:${folder}` as AgentId,
      references: agent.sources.skills.map((source) => source.id),
    });
    const skillActionDefinitions = skillActionDefinitionsForSkills([
      ...resolvedSkills.skills.values(),
    ]);
    const cleanup = cleanupGeneratedRuntimeCapabilities({
      capabilities: agent.capabilities,
      skillActionDefinitions,
    });
    if (sameCapabilities(agent.capabilities, cleanup.capabilities)) {
      continue;
    }
    nextSettings ??= structuredClone(input.settings);
    nextSettings.agents[folder].capabilities = cleanup.capabilities;
    converted.push(
      ...cleanup.converted.map((item) => ({ agentFolder: folder, ...item })),
    );
    dropped.push(
      ...cleanup.dropped.map((rule) => ({ agentFolder: folder, rule })),
    );
  }

  return {
    settings: nextSettings ?? input.settings,
    changed: Boolean(nextSettings),
    converted,
    dropped,
  };
}

function sameCapabilities(
  left: readonly RuntimeConfiguredAgentCapability[],
  right: readonly RuntimeConfiguredAgentCapability[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (capability, index) =>
      capability.id === right[index]?.id &&
      capability.version === right[index]?.version,
  );
}
