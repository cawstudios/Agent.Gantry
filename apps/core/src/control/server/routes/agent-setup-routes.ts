import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  CreateAgentSetupRequestSchema,
  UpdateAgentSetupRequestSchema,
} from '@gantry/contracts';

import {
  AgentSetupDraftConflictError,
  AgentSetupDraftService,
} from '../../../application/agents/agent-setup-draft-service.js';
import { ApplicationError } from '../../../application/common/application-error.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { Agent, AgentId } from '../../../domain/agent/agent.js';
import type { AgentSetupDraft } from '../../../domain/agent/agent-setup-draft.js';
import type { AppId } from '../../../domain/app/app.js';
import { nowIso } from '../../../shared/time/datetime.js';
import { RUNTIME_EVENT_TYPES } from '../../../domain/events/runtime-event-types.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';

const SETUP_ROUTE = /^\/v1\/agent-setups\/([^/]+)$/;

export async function handleAgentSetupRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/agent-setups' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const parsed = CreateAgentSetupRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent setup draft');
      return true;
    }
    if (parsed.data.appId !== auth.appId) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot create agent for app');
      return true;
    }
    const result = await service().create({
      appId: auth.appId as AppId,
      name: parsed.data.name,
      purpose: parsed.data.purpose,
    });
    sendJson(res, 201, toResponse(ctx, result.agent, result.draft));
    return true;
  }

  const match = SETUP_ROUTE.exec(pathname);
  if (!match) return false;
  const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
  if (!auth) return true;
  const input = {
    appId: auth.appId as AppId,
    agentId: decodeURIComponent(match[1]!) as AgentId,
  };

  try {
    if (req.method === 'GET') {
      const result = await service().get(input);
      sendJson(res, 200, toResponse(ctx, result.agent, result.draft));
      return true;
    }
    if (req.method === 'PATCH') {
      const parsed = UpdateAgentSetupRequestSchema.safeParse(
        await readJson(req),
      );
      if (!parsed.success) {
        sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent setup update');
        return true;
      }
      const result = await service().update({
        ...input,
        expectedVersion: parsed.data.expectedVersion,
        patch: patchForStep(parsed.data),
      });
      sendJson(res, 200, toResponse(ctx, result.agent, result.draft));
      return true;
    }
    if (req.method === 'DELETE') {
      await service().discard(input);
      sendJson(res, 200, { discarded: true, agentId: input.agentId });
      return true;
    }
  } catch (error) {
    if (error instanceof AgentSetupDraftConflictError) {
      sendError(res, 409, 'CONFLICT', error.message);
      return true;
    }
    if (error instanceof ApplicationError) {
      sendError(
        res,
        error.code === 'NOT_FOUND' ? 404 : 400,
        error.code,
        error.message,
      );
      return true;
    }
    throw error;
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE');
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  return true;
}

function service(): AgentSetupDraftService {
  const repositories = getRuntimeStorage().repositories;
  return new AgentSetupDraftService({
    agents: repositories.agents,
    drafts: repositories.agentSetupDrafts,
    ids: { generate: randomUUID },
    clock: { now: nowIso },
    audit: async (input) => {
      await getRuntimeStorage().runtimeEvents.publish({
        appId: input.appId,
        agentId: input.agentId,
        eventType:
          input.action === 'created'
            ? RUNTIME_EVENT_TYPES.AGENT_SETUP_DRAFT_CREATED
            : input.action === 'saved'
              ? RUNTIME_EVENT_TYPES.AGENT_SETUP_DRAFT_SAVED
              : RUNTIME_EVENT_TYPES.AGENT_SETUP_DRAFT_DISCARDED,
        actor: 'control',
        payload: {},
      });
    },
  });
}

function patchForStep(
  input: ReturnType<typeof UpdateAgentSetupRequestSchema.parse>,
) {
  switch (input.step) {
    case 'agent':
      return {
        name: input.name,
        purpose: input.purpose,
        currentStage: 'model' as const,
      };
    case 'model':
      return {
        modelAlias: input.modelAlias,
        currentStage: 'connection' as const,
      };
    case 'connection':
      return {
        connection: input.connection,
        currentStage: 'conversation' as const,
      };
    case 'conversation':
      return {
        conversation: input.conversation,
        currentStage: 'profile' as const,
      };
    case 'profile':
      return { currentStage: 'review' as const };
    case 'review':
      return { currentStage: 'review' as const };
  }
}

function toResponse(
  ctx: ControlRouteContext,
  agent: Agent,
  draft: AgentSetupDraft,
) {
  return {
    agentId: agent.id,
    appId: agent.appId,
    name: agent.name,
    purpose: draft.purpose ?? null,
    modelAlias: draft.modelAlias ?? null,
    connection: draft.connection ?? null,
    conversation: draft.conversation ?? null,
    currentStage: draft.currentStage,
    version: draft.version,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}
