const THREAD_QUEUE_MARKER = '::thread:';
const AGENT_QUEUE_MARKER = '::agent:';
const PROVIDER_ACCOUNT_QUEUE_MARKER = '::provider_account:';

export function normalizeThreadQueueId(
  threadId?: string | null,
): string | undefined {
  const normalized = threadId?.trim();
  return normalized || undefined;
}

export function makeThreadQueueKey(
  chatJid: string,
  threadId?: string | null,
): string {
  const normalized = normalizeThreadQueueId(threadId);
  if (!normalized) return chatJid;
  return `${chatJid}${THREAD_QUEUE_MARKER}${encodeURIComponent(normalized)}`;
}

export function makeAgentThreadQueueKey(
  chatJid: string,
  agentId?: string | null,
  threadId?: string | null,
  providerAccountId?: string | null,
): string {
  const base = makeThreadQueueKey(chatJid, threadId);
  const normalizedAgentId = agentId?.trim();
  const normalizedProviderAccountId = providerAccountId?.trim();
  const agentKey = normalizedAgentId
    ? `${base}${AGENT_QUEUE_MARKER}${encodeURIComponent(normalizedAgentId)}`
    : base;
  if (!normalizedProviderAccountId) return agentKey;
  return `${agentKey}${PROVIDER_ACCOUNT_QUEUE_MARKER}${encodeURIComponent(normalizedProviderAccountId)}`;
}

export function parseThreadQueueKey(queueJid: string): {
  chatJid: string;
  threadId?: string;
} {
  const providerMarkerIndex = queueJid.lastIndexOf(
    PROVIDER_ACCOUNT_QUEUE_MARKER,
  );
  const routeQueueJid =
    providerMarkerIndex < 0 ? queueJid : queueJid.slice(0, providerMarkerIndex);
  const agentMarkerIndex = routeQueueJid.lastIndexOf(AGENT_QUEUE_MARKER);
  const threadQueueJid =
    agentMarkerIndex < 0
      ? routeQueueJid
      : routeQueueJid.slice(0, agentMarkerIndex);
  const markerIndex = threadQueueJid.lastIndexOf(THREAD_QUEUE_MARKER);
  if (markerIndex < 0) return { chatJid: threadQueueJid };

  const chatJid = threadQueueJid.slice(0, markerIndex);
  const encodedThreadId = threadQueueJid.slice(
    markerIndex + THREAD_QUEUE_MARKER.length,
  );
  if (!chatJid || !encodedThreadId) return { chatJid: threadQueueJid };

  try {
    return {
      chatJid,
      threadId: normalizeThreadQueueId(decodeURIComponent(encodedThreadId)),
    };
  } catch {
    return { chatJid: threadQueueJid };
  }
}

export function parseAgentThreadQueueKey(queueJid: string): {
  chatJid: string;
  threadId?: string;
  agentId?: string;
  providerAccountId?: string;
} {
  const providerMarkerIndex = queueJid.lastIndexOf(
    PROVIDER_ACCOUNT_QUEUE_MARKER,
  );
  const providerSuffix =
    providerMarkerIndex < 0
      ? undefined
      : queueJid.slice(
          providerMarkerIndex + PROVIDER_ACCOUNT_QUEUE_MARKER.length,
        );
  const routeQueueJid =
    providerMarkerIndex < 0 ? queueJid : queueJid.slice(0, providerMarkerIndex);
  const agentMarkerIndex = routeQueueJid.lastIndexOf(AGENT_QUEUE_MARKER);
  const parsed = parseThreadQueueKey(queueJid);
  let providerAccountId: string | undefined;
  if (providerSuffix) {
    try {
      providerAccountId =
        decodeURIComponent(providerSuffix).trim() || undefined;
    } catch {
      providerAccountId = undefined;
    }
  }
  if (agentMarkerIndex < 0) {
    return providerAccountId ? { ...parsed, providerAccountId } : parsed;
  }
  const encodedAgentId = routeQueueJid.slice(
    agentMarkerIndex + AGENT_QUEUE_MARKER.length,
  );
  if (!encodedAgentId) return parsed;
  try {
    const agentId = decodeURIComponent(encodedAgentId).trim();
    const withProvider = providerAccountId ? { providerAccountId } : {};
    return agentId ? { ...parsed, agentId, ...withProvider } : parsed;
  } catch {
    return parsed;
  }
}

export function findConversationRoutesForChat<T>(
  routes: Record<string, T>,
  chatJid: string,
  threadId?: string | null,
  providerAccountId?: string | null,
): Array<[string, T]> {
  const normalizedThreadId = normalizeThreadQueueId(threadId);
  const normalizedProviderAccountId = providerAccountId?.trim();
  const wholeConversationRoutes: Array<[string, T]> = [];
  const threadRoutes: Array<[string, T]> = [];
  for (const entry of Object.entries(routes)) {
    const parsed = parseAgentThreadQueueKey(entry[0]);
    if (parsed.chatJid !== chatJid) continue;
    if (
      normalizedProviderAccountId &&
      parsed.providerAccountId !== normalizedProviderAccountId
    ) {
      continue;
    }
    if (parsed.threadId) {
      if (normalizedThreadId && parsed.threadId === normalizedThreadId) {
        threadRoutes.push(entry);
      }
      continue;
    }
    wholeConversationRoutes.push(entry);
  }
  return threadRoutes.length > 0 ? threadRoutes : wholeConversationRoutes;
}

export function findSingleConversationRouteForChat<T>(
  routes: Record<string, T>,
  chatJid: string,
  threadId?: string | null,
  providerAccountId?: string | null,
): T | undefined {
  const matches = findConversationRoutesForChat(
    routes,
    chatJid,
    threadId,
    providerAccountId,
  );
  if (providerAccountId && matches.length > 1) {
    throw new Error(
      `Conversation route is ambiguous for ${chatJid} under provider account ${providerAccountId}`,
    );
  }
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

export function routesForConversationId<T extends { conversationId?: string }>(
  routes: Record<string, T>,
  conversationId: string | null | undefined,
): Record<string, T> {
  if (!conversationId) return {};
  return Object.fromEntries(
    Object.entries(routes).filter(
      ([, route]) => route.conversationId === conversationId,
    ),
  );
}

export function findConversationRouteForQueue<T>(
  routes: Record<string, T>,
  queueJid: string,
): T | undefined {
  const queue = parseAgentThreadQueueKey(queueJid);
  const queueThreadId = normalizeThreadQueueId(queue.threadId);
  const queueAgentId = queue.agentId?.trim();
  const queueProviderAccountId = queue.providerAccountId?.trim();
  const candidates: Array<{ route: T; threadId?: string }> = [];

  for (const [key, route] of Object.entries(routes)) {
    const parsed = parseAgentThreadQueueKey(key);
    if (parsed.chatJid !== queue.chatJid) continue;
    if (
      queueProviderAccountId &&
      parsed.providerAccountId !== queueProviderAccountId
    )
      continue;
    if (queueAgentId && parsed.agentId !== queueAgentId) continue;
    candidates.push({ route, threadId: parsed.threadId });
  }

  const exactThreadRoutes = queueThreadId
    ? candidates.filter((candidate) => candidate.threadId === queueThreadId)
    : [];
  const wholeConversationRoutes = candidates.filter(
    (candidate) => !candidate.threadId,
  );
  const matches =
    queueThreadId && exactThreadRoutes.length > 0
      ? exactThreadRoutes
      : wholeConversationRoutes;
  return matches.length === 1 ? matches[0]?.route : undefined;
}

export function firstThreadQueueId(
  ...threadIds: Array<string | null | undefined>
): string | undefined {
  for (const threadId of threadIds) {
    const normalized = normalizeThreadQueueId(threadId);
    if (normalized) return normalized;
  }
  return undefined;
}
