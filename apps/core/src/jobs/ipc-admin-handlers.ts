import { MYCLAW_HOME } from '../config/index.js';
import { nowIso } from '../infrastructure/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { validateRuntimePreflightWithStorage } from '../config/preflight.js';
import { TaskHandler } from './ipc-types.js';
import {
  createTaskResponder,
  restartServiceForRuntimeHome,
  toTrimmedString,
} from './ipc-shared.js';

const refreshGroupsHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
    reject('Only the main agent can refresh groups.', 'forbidden');
    return;
  }

  try {
    logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
    await deps.syncGroups(true);
    const availableGroups = await deps.getAvailableGroups();
    await deps.writeGroupsSnapshot(
      sourceGroup,
      true,
      availableGroups,
      new Set(Object.keys(registeredGroups)),
    );
    accept('Group metadata refresh completed.');
  } catch (err) {
    logger.error({ err, sourceGroup }, 'refresh_groups failed unexpectedly');
    reject(
      err instanceof Error ? err.message : 'Failed to refresh group metadata.',
      'internal_error',
    );
  }
};

const registerAgentHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized register_agent attempt blocked');
    reject('Only the main agent can register new agents.', 'forbidden');
    return;
  }
  if (data.jid && data.name && data.folder && data.trigger) {
    if (!isValidGroupFolder(data.folder)) {
      logger.warn(
        { sourceGroup, folder: data.folder },
        'Invalid register_agent request - unsafe folder name',
      );
      reject(`Invalid agent folder: ${data.folder}`, 'invalid_request');
      return;
    }
    const existingGroup = registeredGroups[data.jid];
    await deps.registerGroup(data.jid, {
      name: data.name,
      folder: data.folder,
      trigger: data.trigger,
      added_at: nowIso(),
      agentConfig: data.agentConfig,
      requiresTrigger: data.requiresTrigger,
      isMain: existingGroup?.isMain,
    });
    accept(`Agent "${data.name}" registered.`);
    return;
  }
  logger.warn(
    { data },
    'Invalid register_agent request - missing required fields',
  );
  reject(
    'Missing required fields: jid, name, folder, trigger.',
    'invalid_request',
  );
};

const serviceRestartHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain } = context;
  const taskId = toTrimmedString(data.taskId, { maxLen: 128 });
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    taskId,
    data.authThreadId,
  );
  if (!isMain) {
    logger.warn(
      { sourceGroup },
      'Unauthorized service_restart attempt blocked',
    );
    reject('Only the main agent can restart the service.', 'forbidden');
    return;
  }

  try {
    const validation = await validateRuntimePreflightWithStorage(MYCLAW_HOME);
    if (!validation.ok) {
      reject(
        validation.failure?.summary ||
          'Runtime configuration validation failed.',
        'preflight_failed',
        validation.failure?.details || [],
      );
      return;
    }

    accept('Service restart accepted. Restarting now.');

    setTimeout(() => {
      const restartOutcome = restartServiceForRuntimeHome(MYCLAW_HOME);
      if (!restartOutcome.ok) {
        logger.error(
          { sourceGroup, taskId, error: restartOutcome.message },
          'Service restart failed after acknowledgment',
        );
        return;
      }
      logger.info(
        { sourceGroup, taskId, message: restartOutcome.message },
        'Service restart completed',
      );
    }, 0);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Service restart failed with an unexpected error.';
    logger.error(
      { sourceGroup, taskId, err },
      'Error while handling service_restart IPC task',
    );
    reject(message, 'internal_error');
  }
};

export const adminTaskHandlers: Record<string, TaskHandler> = {
  refresh_groups: refreshGroupsHandler,
  register_agent: registerAgentHandler,
  service_restart: serviceRestartHandler,
};
