import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { Job, JobSetupBlocker } from '../../domain/types.js';

type ReadinessJob = Pick<
  Job,
  'agent_task' | 'execution_context' | 'workspace_key'
>;

export function invalidWorkspaceConfigBlocker(
  job: ReadinessJob,
): JobSetupBlocker | null {
  const workspaceKey =
    typeof job.workspace_key === 'string' ? job.workspace_key.trim() : '';
  if (!workspaceKey) {
    return invalidWorkspaceBlocker(
      'Job workspace is not configured. The job cannot resolve its runtime workspace.',
    );
  }
  const executionContext = job.execution_context as
    | { workspaceKey?: unknown; conversationJid?: unknown }
    | null
    | undefined;
  if (executionContext) {
    const ctxWorkspaceKey =
      typeof executionContext.workspaceKey === 'string'
        ? executionContext.workspaceKey.trim()
        : '';
    const ctxConversationJid =
      typeof executionContext.conversationJid === 'string'
        ? executionContext.conversationJid.trim()
        : '';
    if (!ctxWorkspaceKey || !ctxConversationJid) {
      return invalidWorkspaceBlocker(
        'Job execution context is invalid. It is missing a workspace key or conversation install.',
      );
    }
  }
  return null;
}

export async function pinnedSkillBlocker(input: {
  job: ReadinessJob;
  appId: string;
  agentId: string;
  repository?: SkillCatalogRepository;
}): Promise<JobSetupBlocker | null> {
  const required = input.job.agent_task?.requiredSkill;
  if (!required) return null;
  const skills =
    (await input.repository?.listEnabledSkillsForAgent({
      appId: input.appId as never,
      agentId: input.agentId as never,
    })) ?? [];
  if (
    skills.some(
      (skill) =>
        skill.name === required.name &&
        skill.storage?.contentHash === required.contentHash,
    )
  ) {
    return null;
  }
  return {
    state: 'missing_capability',
    requirementType: 'skill',
    requirementId: required.name,
    message: `This job requires exact skill ${required.name}@${required.contentHash}.`,
    nextAction:
      'Install and bind the exact skill artifact, then recheck the job.',
  };
}

function invalidWorkspaceBlocker(message: string): JobSetupBlocker {
  return {
    state: 'broker_unreachable',
    requirementType: 'tool',
    requirementId: 'job_runtime',
    message,
    nextAction:
      'Fix the job configuration or restore the runtime broker, then recheck the job.',
  };
}
