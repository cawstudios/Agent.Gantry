import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import type { Job } from '../domain/types.js';

export async function resolveExecutionSkillSelection(input: {
  requiredSkill?: NonNullable<Job['agent_task']>['requiredSkill'];
  appId: string;
  agentId: string;
  repository?: SkillCatalogRepository;
  selected: { ids?: string[]; displays?: string[] };
}): Promise<{ ids?: string[]; displays?: string[] }> {
  const required = input.requiredSkill;
  if (!required) return input.selected;
  const skill = (
    (await input.repository?.listEnabledSkillsForAgent({
      appId: input.appId as never,
      agentId: input.agentId as never,
    })) ?? []
  ).find((candidate) => candidate.name === required.name);
  if (
    !skill ||
    skill.storage?.contentHash !== required.contentHash ||
    !input.selected.ids?.includes(skill.id)
  ) {
    throw new Error(
      `Required skill ${required.name}@${required.contentHash} is not installed and bound exactly as requested.`,
    );
  }
  return {
    ids: [skill.id],
    displays: (input.selected.displays ?? []).filter((display) =>
      display.includes(required.name),
    ),
  };
}
