import { MYCLAW_HOME } from '../index.js';
import type { RuntimeConversationRouteRepository } from '../../domain/repositories/ops-repo.js';
import type { SettingsDesiredStateRepositories } from './desired-state-service.js';
import { mirrorAgentToolRulesToRuntimeSettings } from './runtime-settings.js';
import { addAgentToolRulesToSyncedRuntimeSettings } from './restart-sync.js';

export type AgentToolRuleSettingsRepositories =
  SettingsDesiredStateRepositories;

export function createAgentToolRuleSettingsMirror(input: {
  opsRepository: RuntimeConversationRouteRepository;
  repositories?: AgentToolRuleSettingsRepositories;
  reloadRuntimeState: () => Promise<void>;
}): (sourceAgentFolder: string, rules: string[]) => Promise<void> | void {
  return (sourceAgentFolder, rules) =>
    input.repositories
      ? addAgentToolRulesToSyncedRuntimeSettings({
          runtimeHome: MYCLAW_HOME,
          agentFolder: sourceAgentFolder,
          rules,
          ops: input.opsRepository,
          repositories: input.repositories,
          reloadRuntimeState: input.reloadRuntimeState,
        })
      : mirrorAgentToolRulesToRuntimeSettings({
          runtimeHome: MYCLAW_HOME,
          agentFolder: sourceAgentFolder,
          rules,
        });
}
