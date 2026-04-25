import type { RegisteredGroup } from '../core/types.js';
import { logger } from '../core/logger.js';
import type { ConfiguredAgent } from './agent-config-registry.js';

export interface ReconcileAgentChannelBindingsOptions {
  configuredAgents: Record<string, ConfiguredAgent>;
  registeredGroups: Record<string, RegisteredGroup>;
  persist: (jid: string, group: RegisteredGroup) => void;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
}

export interface ReconcileAgentChannelBindingsResult {
  reboundJids: string[];
  missingJids: string[];
  orphanFolders: string[];
}

export function reconcileAgentChannelBindings(
  options: ReconcileAgentChannelBindingsOptions,
): ReconcileAgentChannelBindingsResult {
  const log = options.logger || logger;
  const configuredAgents = Object.values(options.configuredAgents);
  const configuredFolders = new Set(
    configuredAgents.map((agent) => agent.folder),
  );
  const reboundJids: string[] = [];
  const missingJids: string[] = [];

  for (const agent of configuredAgents) {
    for (const jid of agent.channelJids) {
      const group = options.registeredGroups[jid];
      if (!group) {
        missingJids.push(jid);
        log.warn(
          { agentId: agent.id, folder: agent.folder, jid },
          'Configured agent channel binding has no registered group',
        );
        continue;
      }
      if (group.folder === agent.folder) continue;

      const updatedGroup: RegisteredGroup = {
        ...group,
        folder: agent.folder,
      };
      options.registeredGroups[jid] = updatedGroup;
      options.persist(jid, updatedGroup);
      reboundJids.push(jid);
      log.info(
        {
          agentId: agent.id,
          jid,
          previousFolder: group.folder,
          nextFolder: agent.folder,
        },
        'Rebound registered channel to configured agent',
      );
    }
  }

  const orphanFolders = [
    ...new Set(
      Object.values(options.registeredGroups)
        .map((group) => group.folder)
        .filter((folder) => !configuredFolders.has(folder)),
    ),
  ].sort();

  for (const folder of orphanFolders) {
    log.warn(
      { folder },
      'Registered channel folder is not backed by agent.yaml',
    );
  }

  return { reboundJids, missingJids, orphanFolders };
}
