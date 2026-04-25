import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  MYCLAW_CREDENTIAL_MODE,
  ONECLI_URL,
} from '../../config/index.js';
import { resolveHostCredentialMode } from '../../config/credentials/mode.js';
import { assertValidOnecliUrl } from '../../infrastructure/onecli/policy.js';
import { encodeGroupMessageCursor } from '../../shared/message-cursor.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { RegisteredGroup, ThinkingOverride } from '../../domain/types.js';
import {
  createGroupProcessor,
  GroupProcessingDeps,
} from '../../runtime/group-processing.js';
import { listAvailableGroups } from '../../runtime/group-registry.js';
import { GroupQueue } from '../../runtime/group-queue.js';
import { parseThreadQueueKey } from '../../runtime/thread-queue-key.js';
import {
  registerGroup as registerGroupEntry,
  setGroupModelOverride as setGroupModelOverrideEntry,
  setGroupThinkingOverride as setGroupThinkingOverrideEntry,
} from '../../runtime/group-registry.js';
import type { OpsRepository } from '../../domain/repositories/ops-repo.js';
import { makeSessionScopeKey } from '../../domain/repositories/ops-repo.js';
import { getRuntimeOpsRepository } from '../../infrastructure/postgres/runtime-store.js';

type OneCliLike = Pick<OneCLI, 'ensureAgent'>;

export interface RuntimeApp {
  queue: GroupQueue;
  loadState: () => Promise<void>;
  saveState: () => Promise<void>;
  getOrRecoverCursor: (chatJid: string) => Promise<string>;
  registerGroup: (jid: string, group: RegisteredGroup) => Promise<void>;
  setGroupModelOverride: (
    chatJid: string,
    model: string | undefined,
  ) => Promise<void>;
  setGroupThinkingOverride: (
    chatJid: string,
    thinking: ThinkingOverride | undefined,
  ) => Promise<void>;
  getAvailableGroups: () => Promise<
    import('../../runtime/agent-spawn.js').AvailableGroup[]
  >;
  setRegisteredGroupsForTest: (groups: Record<string, RegisteredGroup>) => void;
  ensureOneCLIAgentsForRegisteredGroups: () => void;
  clearSessionForChatJid: (
    chatJid: string,
    threadId?: string | null,
  ) => Promise<void>;
  processGroupMessages: (
    chatJid: string,
    options?: { queued?: boolean },
  ) => Promise<boolean>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
  setChannelRuntime: (runtime: GroupProcessingDeps['channelRuntime']) => void;
}

export interface RuntimeAppOptions {
  onecli?: OneCliLike;
  queue?: GroupQueue;
  runAgent?: GroupProcessingDeps['runAgent'];
  opsRepository?: OpsRepository;
}

export function createRuntimeApp(options: RuntimeAppOptions = {}): RuntimeApp {
  let lastTimestamp = '';
  let sessions: Record<string, string> = {};
  let registeredGroups: Record<string, RegisteredGroup> = {};
  let lastAgentTimestamp: Record<string, string> = {};
  let stateSaveInFlight: Promise<void> | undefined;
  let stateSaveDirty = false;

  const queue = options.queue ?? new GroupQueue();
  const credentialMode = resolveHostCredentialMode(MYCLAW_CREDENTIAL_MODE);
  const onecli =
    options.onecli ??
    (credentialMode === 'onecli' && ONECLI_URL.trim()
      ? new OneCLI({ url: assertValidOnecliUrl(ONECLI_URL) })
      : undefined);
  const ops = () => options.opsRepository ?? getRuntimeOpsRepository();
  let channelRuntime: GroupProcessingDeps['channelRuntime'] = {
    hasChannel: () => false,
    supportsStreaming: () => false,
    supportsProgress: () => false,
    sendMessage: async () => {},
    sendStreamingChunk: async () => false,
    resetStreaming: () => {},
    setTyping: async () => {},
    sendProgressUpdate: async () => {},
  };

  function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
    if (group.isMain) return;
    if (!onecli) return;
    const identifier = group.folder.toLowerCase().replace(/_/g, '-');
    onecli.ensureAgent({ name: group.name, identifier }).then(
      (res) => {
        logger.info(
          { jid, identifier, created: res.created },
          'OneCLI agent ensured',
        );
      },
      (err) => {
        logger.debug(
          { jid, identifier, err: String(err) },
          'OneCLI agent ensure skipped',
        );
      },
    );
  }

  async function loadState(): Promise<void> {
    const repository = ops();
    const [
      loadedLastTimestamp,
      agentTs,
      loadedSessions,
      loadedRegisteredGroups,
    ] = await Promise.all([
      repository.getRouterState('last_timestamp'),
      repository.getRouterState('last_agent_timestamp'),
      repository.getAllSessions(),
      repository.getAllRegisteredGroups(),
    ]);
    lastTimestamp = loadedLastTimestamp || '';
    try {
      lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      lastAgentTimestamp = {};
    }
    sessions = loadedSessions;
    registeredGroups = loadedRegisteredGroups;
    logger.info(
      { groupCount: Object.keys(registeredGroups).length },
      'State loaded',
    );
  }

  async function saveState(): Promise<void> {
    stateSaveDirty = true;
    if (stateSaveInFlight) return stateSaveInFlight;

    stateSaveInFlight = (async () => {
      do {
        stateSaveDirty = false;
        const timestamp = lastTimestamp;
        const agentTimestampJson = JSON.stringify(lastAgentTimestamp);
        await Promise.all([
          ops().setRouterState('last_timestamp', timestamp),
          ops().setRouterState('last_agent_timestamp', agentTimestampJson),
        ]);
      } while (stateSaveDirty);
    })().finally(() => {
      stateSaveInFlight = undefined;
    });

    return stateSaveInFlight;
  }

  async function getOrRecoverCursor(chatJid: string): Promise<string> {
    const existing = lastAgentTimestamp[chatJid];
    if (existing) return existing;

    const parsed = parseThreadQueueKey(chatJid);
    if (parsed.threadId) return '';

    const baseChatJid = parsed.chatJid;
    const baseExisting = lastAgentTimestamp[baseChatJid];
    if (baseExisting) {
      lastAgentTimestamp[chatJid] = baseExisting;
      return baseExisting;
    }

    const botCursor = await ops().getLastBotMessageCursor(baseChatJid);
    if (botCursor) {
      const encoded = encodeGroupMessageCursor(botCursor);
      logger.info(
        {
          chatJid: baseChatJid,
          recoveredFrom: botCursor.timestamp,
          recoveredFromId: botCursor.id,
        },
        'Recovered message cursor from last bot reply',
      );
      lastAgentTimestamp[chatJid] = encoded;
      await saveState();
      return encoded;
    }
    return '';
  }

  async function registerGroup(
    jid: string,
    group: RegisteredGroup,
  ): Promise<void> {
    await registerGroupEntry(registeredGroups, jid, group, {
      assistantName: ASSISTANT_NAME,
      persist: (persistJid, persistedGroup) =>
        ops().setRegisteredGroup(persistJid, persistedGroup),
      ensureOneCLIAgent,
    });
  }

  async function setGroupModelOverride(
    chatJid: string,
    model: string | undefined,
  ): Promise<void> {
    await setGroupModelOverrideEntry(
      registeredGroups,
      chatJid,
      model,
      (jid, group) => ops().setRegisteredGroup(jid, group),
    );
  }

  async function setGroupThinkingOverride(
    chatJid: string,
    thinking: ThinkingOverride | undefined,
  ): Promise<void> {
    await setGroupThinkingOverrideEntry(
      registeredGroups,
      chatJid,
      thinking,
      (jid, group) => ops().setRegisteredGroup(jid, group),
    );
  }

  async function getAvailableGroups(): Promise<
    import('../../runtime/agent-spawn.js').AvailableGroup[]
  > {
    return listAvailableGroups(await ops().getAllChats(), registeredGroups);
  }

  function setRegisteredGroupsForTest(
    groups: Record<string, RegisteredGroup>,
  ): void {
    registeredGroups = groups;
  }

  function ensureOneCLIAgentsForRegisteredGroups(): void {
    for (const [jid, group] of Object.entries(registeredGroups)) {
      ensureOneCLIAgent(jid, group);
    }
  }

  async function clearSessionForChatJid(
    chatJid: string,
    threadId?: string | null,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    await ops().deleteSession(group.folder, threadId);
    delete sessions[makeSessionScopeKey(group.folder, threadId)];
  }

  const groupProcessor = createGroupProcessor({
    channelRuntime: {
      hasChannel: (chatJid) => channelRuntime.hasChannel(chatJid),
      supportsStreaming: (chatJid) => channelRuntime.supportsStreaming(chatJid),
      supportsProgress: (chatJid) => channelRuntime.supportsProgress(chatJid),
      sendMessage: (chatJid, rawText, options) =>
        channelRuntime.sendMessage(chatJid, rawText, options),
      sendStreamingChunk: (chatJid, rawText, options) =>
        channelRuntime.sendStreamingChunk(chatJid, rawText, options),
      resetStreaming: (chatJid) => channelRuntime.resetStreaming(chatJid),
      setTyping: (chatJid, isTyping) =>
        channelRuntime.setTyping(chatJid, isTyping),
      sendProgressUpdate: (chatJid, text, options) =>
        channelRuntime.sendProgressUpdate(chatJid, text, options),
    },
    getGroup: (chatJid) => registeredGroups[chatJid],
    getSession: (groupFolder, threadId) =>
      sessions[makeSessionScopeKey(groupFolder, threadId)],
    setSession: async (groupFolder, sessionId, threadId) => {
      await ops().setSession(groupFolder, sessionId, threadId);
      sessions[makeSessionScopeKey(groupFolder, threadId)] = sessionId;
    },
    clearSession: async (groupFolder, threadId) => {
      await ops().deleteSession(groupFolder, threadId);
      delete sessions[makeSessionScopeKey(groupFolder, threadId)];
    },
    getCursor: getOrRecoverCursor,
    setCursor: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
    saveState,
    setGroupModelOverride,
    setGroupThinkingOverride,
    getAvailableGroups,
    getRegisteredJids: () => new Set(Object.keys(registeredGroups)),
    opsRepository: options.opsRepository,
    getOpsRepository: ops,
    queue: {
      closeStdin: (chatJid) => queue.closeStdin(chatJid),
      notifyIdle: (chatJid) => queue.notifyIdle(chatJid),
      stopGroup: (chatJid) => queue.stopGroup(chatJid),
      registerProcess: (
        groupJid,
        proc,
        containerName,
        groupFolder,
        stopAliasJids,
        threadId,
      ) =>
        queue.registerProcess(
          groupJid,
          proc,
          containerName,
          groupFolder,
          stopAliasJids,
          threadId,
        ),
    },
    runAgent: options.runAgent,
  });

  return {
    queue,
    loadState,
    saveState,
    getOrRecoverCursor,
    registerGroup,
    setGroupModelOverride,
    setGroupThinkingOverride,
    getAvailableGroups,
    setRegisteredGroupsForTest,
    ensureOneCLIAgentsForRegisteredGroups,
    clearSessionForChatJid,
    processGroupMessages: (chatJid, options) =>
      groupProcessor.processGroupMessages(chatJid, options),
    getRegisteredGroups: () => registeredGroups,
    getLastTimestamp: () => lastTimestamp,
    setLastTimestamp: (timestamp) => {
      lastTimestamp = timestamp;
    },
    setAgentCursor: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
    setChannelRuntime: (runtime) => {
      channelRuntime = runtime;
    },
  };
}

let defaultRuntimeApp: RuntimeApp | null = null;

export function getDefaultRuntimeApp(): RuntimeApp {
  if (!defaultRuntimeApp) {
    defaultRuntimeApp = createRuntimeApp();
  }
  return defaultRuntimeApp;
}

export function getAvailableGroups(): Promise<
  import('../../runtime/agent-spawn.js').AvailableGroup[]
> {
  return getDefaultRuntimeApp().getAvailableGroups();
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  getDefaultRuntimeApp().setRegisteredGroupsForTest(groups);
}
