export function migrateLegacyAgentBindings(
  document: Record<string, unknown>,
): Record<string, unknown> {
  let next = migrateLegacyProviderConnections(document);
  next = migrateLegacyConversationInstalls(next);
  next = migrateLegacyTopLevelBindings(next);
  next = migrateLegacyModelAccess(next);
  const agents = recordOrUndefined(next.agents);
  const conversations = recordOrUndefined(next.conversations);
  if (!agents || !conversations) return next;
  if (
    !Object.values(agents).some(
      (agent) => recordOrUndefined(agent)?.bindings !== undefined,
    )
  ) {
    return next;
  }

  next = structuredClone(next);
  const nextAgents = recordOrUndefined(next.agents);
  const nextConversations = recordOrUndefined(next.conversations);
  const providerAccounts = recordOrUndefined(next.provider_accounts) ?? {};
  if (!nextAgents || !nextConversations) return next;

  for (const [agentId, agentRaw] of Object.entries(nextAgents)) {
    const agent = recordOrUndefined(agentRaw);
    const bindings = recordOrUndefined(agent?.bindings);
    if (!agent || !bindings) continue;
    delete agent.bindings;

    for (const [bindingId, bindingRaw] of Object.entries(bindings)) {
      const binding = recordOrUndefined(bindingRaw);
      const jid = stringValue(binding?.jid);
      if (!binding || !jid) continue;
      const conversation = findLegacyBindingConversation({
        conversations: nextConversations,
        binding,
        jid,
      });
      if (!conversation) continue;
      const [conversationId, conversationRaw] = conversation;
      const conversationDoc = recordOrUndefined(conversationRaw);
      if (!conversationDoc) continue;
      const installProviderAccount = providerAccountForLegacyInstall({
        providerAccounts,
        conversation: conversationDoc,
        binding,
        agentId,
      });
      if (!installProviderAccount) continue;
      const installedAgents =
        recordOrUndefined(conversationDoc.installed_agents) ?? {};
      conversationDoc.installed_agents = installedAgents;
      installedAgents[uniqueInstallId(bindingId, installedAgents)] =
        stripUndefinedDeep({
          agent: agentId,
          provider_account: installProviderAccount,
          thread_id: stringValue(binding.thread_id ?? binding.threadId),
          status: 'active',
          added_at: stringValue(binding.added_at ?? binding.addedAt),
          memory_scope: stringValue(
            binding.memory_scope ?? binding.memoryScope,
          ),
          trigger: stringValue(binding.trigger),
          requires_trigger: binding.requires_trigger ?? binding.requiresTrigger,
          model: stringValue(binding.model),
        });
      if (!conversationDoc.provider_account) {
        conversationDoc.provider_account = installProviderAccount;
      }
      nextConversations[conversationId] = conversationDoc;
    }
  }

  return next;
}

function migrateLegacyProviderConnections(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const providerConnections = recordOrUndefined(document.provider_connections);
  if (!providerConnections) return document;
  const migratableConnections = Object.entries(providerConnections).filter(
    ([, connectionRaw]) => isMigratableProviderConnection(connectionRaw),
  );
  if (migratableConnections.length === 0) return document;

  const next = structuredClone(document);
  const nextProviderConnections = recordOrUndefined(next.provider_connections);
  const providerAccounts = recordOrUndefined(next.provider_accounts) ?? {};
  next.provider_accounts = providerAccounts;
  const agents = recordOrUndefined(next.agents) ?? {};
  next.agents = agents;
  ensureLegacyAgent(agents, 'main_agent');
  stripLegacyAgentFolderFields(agents);

  if (nextProviderConnections) {
    for (const [accountId, connectionRaw] of Object.entries(
      nextProviderConnections,
    )) {
      if (providerAccounts[accountId] !== undefined) continue;
      const connection = recordOrUndefined(connectionRaw);
      if (!connection) continue;
      const agentId =
        stringValue(connection.agent ?? connection.agent_id) ?? 'main_agent';
      ensureLegacyAgent(agents, agentId);
      providerAccounts[accountId] = stripUndefinedDeep({
        ...connection,
        agent: agentId,
      });
    }
    delete next.provider_connections;
  }

  const nextProviders = recordOrUndefined(next.providers);
  if (nextProviders) {
    for (const providerRaw of Object.values(nextProviders)) {
      const provider = recordOrUndefined(providerRaw);
      if (!provider) continue;
      delete provider.default_connection;
      delete provider.defaultConnection;
    }
  }

  return next;
}

function migrateLegacyConversationInstalls(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const conversations = recordOrUndefined(document.conversations);
  if (!conversations) return document;
  const hasLegacyConversationInstall = Object.values(conversations).some(
    (conversationRaw) => {
      const conversation = recordOrUndefined(conversationRaw);
      return (
        conversation?.agent !== undefined ||
        conversation?.trigger !== undefined ||
        conversation?.requires_trigger !== undefined ||
        conversation?.requiresTrigger !== undefined ||
        conversation?.added_at !== undefined ||
        conversation?.addedAt !== undefined ||
        conversation?.memory_scope !== undefined ||
        conversation?.memoryScope !== undefined ||
        conversation?.model !== undefined
      );
    },
  );
  if (!hasLegacyConversationInstall) return document;

  const next = structuredClone(document);
  const nextConversations = recordOrUndefined(next.conversations);
  if (!nextConversations) return next;
  const agents = recordOrUndefined(next.agents) ?? {};
  next.agents = agents;

  for (const [conversationId, conversationRaw] of Object.entries(
    nextConversations,
  )) {
    const conversation = recordOrUndefined(conversationRaw);
    if (!conversation) continue;
    const agentId = stringValue(conversation.agent) ?? 'main_agent';
    ensureLegacyAgent(agents, agentId);
    const installedAgents =
      recordOrUndefined(conversation.installed_agents) ?? {};
    conversation.installed_agents = installedAgents;
    if (!installedAgents[agentId]) {
      installedAgents[agentId] = stripUndefinedDeep({
        agent: agentId,
        provider_account:
          stringValue(conversation.provider_account) ??
          stringValue(conversation.provider_connection),
        status: 'active',
        added_at: stringValue(conversation.added_at ?? conversation.addedAt),
        memory_scope: stringValue(
          conversation.memory_scope ?? conversation.memoryScope,
        ),
        trigger: stringValue(conversation.trigger),
        requires_trigger:
          conversation.requires_trigger ?? conversation.requiresTrigger,
        model: stringValue(conversation.model),
      });
    }
    if (!conversation.provider_account && conversation.provider_connection) {
      conversation.provider_account = conversation.provider_connection;
    }
    delete conversation.provider;
    delete conversation.provider_connection;
    delete conversation.providerConnection;
    delete conversation.agent;
    delete conversation.trigger;
    delete conversation.requires_trigger;
    delete conversation.requiresTrigger;
    delete conversation.added_at;
    delete conversation.addedAt;
    delete conversation.memory_scope;
    delete conversation.memoryScope;
    delete conversation.model;
    nextConversations[conversationId] = conversation;
  }

  return next;
}

function migrateLegacyTopLevelBindings(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const bindings = recordOrUndefined(document.bindings);
  const conversations = recordOrUndefined(document.conversations);
  if (!bindings || !conversations || Object.keys(bindings).length === 0) {
    return document;
  }

  const next = structuredClone(document);
  const nextBindings = recordOrUndefined(next.bindings);
  const nextConversations = recordOrUndefined(next.conversations);
  if (!nextBindings || !nextConversations) return next;
  const agents = recordOrUndefined(next.agents) ?? {};
  next.agents = agents;

  for (const [bindingId, bindingRaw] of Object.entries(nextBindings)) {
    const binding = recordOrUndefined(bindingRaw);
    if (!binding) continue;
    const agentId = stringValue(binding.agent) ?? 'main_agent';
    ensureLegacyAgent(agents, agentId);
    const conversationId = stringValue(binding.conversation);
    if (!conversationId) continue;
    const conversation = recordOrUndefined(nextConversations[conversationId]);
    if (!conversation) continue;
    const providerAccount =
      stringValue(binding.provider_account) ??
      stringValue(binding.provider_connection) ??
      stringValue(conversation.provider_account) ??
      stringValue(conversation.provider_connection);
    if (!providerAccount) continue;
    if (!conversation.provider_account) {
      conversation.provider_account = providerAccount;
    }
    delete conversation.provider;
    delete conversation.provider_connection;
    delete conversation.providerConnection;
    const installedAgents =
      recordOrUndefined(conversation.installed_agents) ?? {};
    conversation.installed_agents = installedAgents;
    installedAgents[uniqueInstallId(bindingId, installedAgents)] =
      stripUndefinedDeep({
        agent: agentId,
        provider_account: providerAccount,
        thread_id: stringValue(binding.thread_id ?? binding.threadId),
        status: 'active',
        added_at: stringValue(binding.added_at ?? binding.addedAt),
        memory_scope: stringValue(binding.memory_scope ?? binding.memoryScope),
        trigger: stringValue(binding.trigger),
        requires_trigger: binding.requires_trigger ?? binding.requiresTrigger,
        model: stringValue(binding.model),
      });
    nextConversations[conversationId] = conversation;
  }

  delete next.bindings;
  return next;
}

function migrateLegacyModelAccess(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const modelAccess = recordOrUndefined(document.model_access);
  if (!modelAccess || modelAccess.mode === undefined) return document;
  const next = structuredClone(document);
  const nextModelAccess = recordOrUndefined(next.model_access);
  if (!nextModelAccess) return next;
  if (nextModelAccess.enabled === undefined) {
    nextModelAccess.enabled = stringValue(nextModelAccess.mode) !== 'disabled';
  }
  delete nextModelAccess.mode;
  return next;
}

function isMigratableProviderConnection(value: unknown): boolean {
  const connection = recordOrUndefined(value);
  return Boolean(
    connection &&
    stringValue(connection.provider) &&
    recordOrUndefined(connection.runtime_secret_refs),
  );
}

function ensureLegacyAgent(
  agents: Record<string, unknown>,
  agentId: string,
): void {
  const existing = recordOrUndefined(agents[agentId]) ?? {};
  if (!stringValue(existing.name)) {
    existing.name = agentId === 'main_agent' ? 'Default Agent' : agentId;
  }
  agents[agentId] = existing;
}

function stripLegacyAgentFolderFields(agents: Record<string, unknown>): void {
  for (const agentRaw of Object.values(agents)) {
    const agent = recordOrUndefined(agentRaw);
    if (!agent) continue;
    const access = recordOrUndefined(agent.access) ?? {};
    if (agent.sources !== undefined && access.sources === undefined) {
      access.sources = agent.sources;
    }
    if (agent.capabilities !== undefined && access.selections === undefined) {
      access.selections = agent.capabilities;
    }
    if (agent.access_preset !== undefined && access.preset === undefined) {
      access.preset = agent.access_preset;
    }
    if (Object.keys(access).length > 0) agent.access = access;
    delete agent.folder;
    delete agent.sources;
    delete agent.capabilities;
    delete agent.access_preset;
  }
}

function findLegacyBindingConversation(input: {
  conversations: Record<string, unknown>;
  binding: Record<string, unknown>;
  jid: string;
}): [string, unknown] | undefined {
  const explicitConversation = stringValue(input.binding.conversation);
  if (explicitConversation && input.conversations[explicitConversation]) {
    return [explicitConversation, input.conversations[explicitConversation]];
  }
  const explicitAccount = stringValue(
    input.binding.provider_account_id ??
      input.binding.providerAccountId ??
      input.binding.provider_account ??
      input.binding.provider_connection_id ??
      input.binding.providerConnectionId,
  );
  const jidSuffix = input.jid.includes(':')
    ? input.jid.slice(input.jid.indexOf(':') + 1)
    : input.jid;
  const candidates = Object.entries(input.conversations).filter(
    ([, conversationRaw]) => {
      const conversation = recordOrUndefined(conversationRaw);
      if (!conversation) return false;
      const externalId = stringValue(
        conversation.external_id ?? conversation.id,
      );
      return externalId === input.jid || externalId === jidSuffix;
    },
  );
  return (
    candidates.find(([, conversationRaw]) => {
      const conversation = recordOrUndefined(conversationRaw);
      return (
        explicitAccount &&
        stringValue(
          conversation?.provider_account ?? conversation?.provider_connection,
        ) === explicitAccount
      );
    }) ?? candidates[0]
  );
}

function providerAccountForLegacyInstall(input: {
  providerAccounts: Record<string, unknown>;
  conversation: Record<string, unknown>;
  binding: Record<string, unknown>;
  agentId: string;
}): string | undefined {
  const requested =
    stringValue(
      input.binding.provider_account_id ??
        input.binding.providerAccountId ??
        input.binding.provider_account ??
        input.binding.provider_connection_id ??
        input.binding.providerConnectionId,
    ) ??
    stringValue(
      input.conversation.provider_account ??
        input.conversation.provider_connection,
    );
  if (!requested) return undefined;
  const account = recordOrUndefined(input.providerAccounts[requested]);
  if (
    !account ||
    stringValue(account.agent ?? account.agent_id) === input.agentId
  ) {
    return requested;
  }
  const provider = stringValue(account.provider);
  const existing = Object.entries(input.providerAccounts).find(
    ([, candidateRaw]) => {
      const candidate = recordOrUndefined(candidateRaw);
      return (
        candidate &&
        stringValue(candidate.provider) === provider &&
        stringValue(candidate.agent ?? candidate.agent_id) === input.agentId
      );
    },
  );
  if (existing) return existing[0];
  const cloneId = `${requested}:agent:${input.agentId}`;
  input.providerAccounts[cloneId] = stripUndefinedDeep({
    ...account,
    external_identity_ref: undefined,
    agent: input.agentId,
    agent_id: undefined,
  });
  return cloneId;
}

function uniqueInstallId(
  installId: string,
  installedAgents: Record<string, unknown>,
): string {
  if (!Object.hasOwn(installedAgents, installId)) return installId;
  let index = 2;
  while (Object.hasOwn(installedAgents, `${installId}_${index}`)) index += 1;
  return `${installId}_${index}`;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      item === undefined ? [] : [[key, stripUndefinedDeep(item)]],
    ),
  );
}

function recordOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
