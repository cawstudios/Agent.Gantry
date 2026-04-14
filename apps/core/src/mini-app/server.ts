import { ServerResponse } from 'http';

import cors from '@fastify/cors';
import Fastify, { FastifyInstance } from 'fastify';

import {
  MINI_APP_API_URL,
  MINI_APP_CORS_ORIGIN,
  MINI_APP_ENABLED,
  MINI_APP_HOST,
  MINI_APP_PORT,
} from '../core/config.js';
import { readEnvFile } from '../core/env.js';
import { logger } from '../core/logger.js';
import { validateTelegramInitData } from './init-data.js';
import { onPlanUpdated } from './plan-events-bus.js';
import {
  approveAllPlanSections,
  getPlanById,
  listPlans,
  rejectPlan,
  updatePlanSection,
} from './plan-store.js';
import { writePlanEvent } from './plan-events.js';
import { PlanEvent } from './types.js';

interface AuthContext {
  userId: string;
  username?: string;
  firstName?: string;
}

function getInitDataFromRequest(request: {
  headers: Record<string, unknown>;
  query?: Record<string, unknown>;
}): string | undefined {
  const headerValue = request.headers['x-telegram-init-data'];
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }
  if (Array.isArray(headerValue) && typeof headerValue[0] === 'string') {
    return headerValue[0].trim() || undefined;
  }
  const queryValue = request.query?.initData;
  if (typeof queryValue === 'string' && queryValue.trim()) {
    return queryValue.trim();
  }
  return undefined;
}

function resolveAuthContext(
  request: {
    headers: Record<string, unknown>;
    query?: Record<string, unknown>;
  },
  telegramBotToken: string,
): AuthContext | null {
  if (!telegramBotToken) {
    return { userId: 'local-dev' };
  }
  const initData = getInitDataFromRequest(request);
  if (!initData) return null;

  const validation = validateTelegramInitData(initData, telegramBotToken);
  if (!validation.valid) return null;

  return {
    userId: validation.userId || 'telegram-user',
    ...(validation.username ? { username: validation.username } : {}),
    ...(validation.firstName ? { firstName: validation.firstName } : {}),
  };
}

function buildPlanEvent(input: {
  type: PlanEvent['type'];
  planId: string;
  sectionIndex?: number;
  userId: string;
  reason?: string;
  newContent?: string;
}): PlanEvent {
  const timestamp = new Date().toISOString();
  if (input.type === 'section_approved') {
    return {
      type: 'section_approved',
      planId: input.planId,
      sectionIndex: input.sectionIndex ?? 0,
      userId: input.userId,
      timestamp,
    };
  }
  if (input.type === 'section_rejected') {
    return {
      type: 'section_rejected',
      planId: input.planId,
      sectionIndex: input.sectionIndex ?? 0,
      userId: input.userId,
      ...(input.reason ? { reason: input.reason } : {}),
      timestamp,
    };
  }
  if (input.type === 'section_edited') {
    return {
      type: 'section_edited',
      planId: input.planId,
      sectionIndex: input.sectionIndex ?? 0,
      userId: input.userId,
      newContent: input.newContent || '',
      timestamp,
    };
  }
  if (input.type === 'plan_approved') {
    return {
      type: 'plan_approved',
      planId: input.planId,
      userId: input.userId,
      timestamp,
    };
  }
  return {
    type: 'plan_rejected',
    planId: input.planId,
    userId: input.userId,
    ...(input.reason ? { reason: input.reason } : {}),
    timestamp,
  };
}

function sendSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function resolveRequestQuery(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== 'object') return {};
  const value = (request as { query?: unknown }).query;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function resolveRequestBody(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== 'object') return {};
  const value = (request as { body?: unknown }).body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requireAuth(
  request: {
    headers: Record<string, unknown>;
    query?: Record<string, unknown>;
  },
  telegramBotToken: string,
): AuthContext {
  const auth = resolveAuthContext(request, telegramBotToken);
  if (!auth) {
    throw new Error('Unauthorized');
  }
  return auth;
}

function parseSectionIndexParam(raw: string): number | null {
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

export interface MiniAppServerHandle {
  close: () => Promise<void>;
}

export async function startMiniAppServer(): Promise<MiniAppServerHandle | null> {
  if (!MINI_APP_ENABLED) {
    logger.info('Mini App API server disabled (MINI_APP_ENABLED is false)');
    return null;
  }

  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const telegramBotToken =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';

  const app: FastifyInstance = Fastify({ logger: false });
  const sseClients = new Map<string, Set<ServerResponse>>();

  await app.register(cors, {
    origin: MINI_APP_CORS_ORIGIN || 'https://app.myclaw.dev',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-telegram-init-data'],
  });

  app.get('/api/health', async () => ({
    ok: true,
    apiUrl: MINI_APP_API_URL || null,
  }));

  app.post('/api/auth/validate', async (request) => {
    const body = resolveRequestBody(request);
    const initData = typeof body.initData === 'string' ? body.initData : '';

    if (!telegramBotToken) {
      return {
        valid: true,
        user: { id: 'local-dev' },
        mode: 'insecure-no-token',
      };
    }

    const validation = validateTelegramInitData(initData, telegramBotToken);
    return {
      valid: validation.valid,
      user: validation.valid
        ? {
            id: validation.userId || 'telegram-user',
            ...(validation.username ? { username: validation.username } : {}),
            ...(validation.firstName
              ? { first_name: validation.firstName }
              : {}),
          }
        : null,
    };
  });

  app.get('/api/plans', async (request, reply) => {
    try {
      const query = resolveRequestQuery(request);
      requireAuth(
        {
          headers: request.headers as Record<string, unknown>,
          query,
        },
        telegramBotToken,
      );
      const groupFolder =
        typeof query.groupFolder === 'string' ? query.groupFolder : undefined;
      return { plans: listPlans(groupFolder || undefined) };
    } catch (err) {
      if (err instanceof Error && err.message === 'Unauthorized') {
        reply.code(401);
        return { ok: false, error: 'Unauthorized' };
      }
      throw err;
    }
  });

  app.get('/api/plans/:planId', async (request, reply) => {
    try {
      requireAuth(
        {
          headers: request.headers as Record<string, unknown>,
          query: resolveRequestQuery(request),
        },
        telegramBotToken,
      );
      const params = request.params as { planId: string };
      const plan = getPlanById(params.planId);
      if (!plan) {
        reply.code(404);
        return { ok: false, error: 'Plan not found' };
      }
      return { plan };
    } catch (err) {
      if (err instanceof Error && err.message === 'Unauthorized') {
        reply.code(401);
        return { ok: false, error: 'Unauthorized' };
      }
      throw err;
    }
  });

  app.get('/api/plans/:planId/stream', async (request, reply) => {
    try {
      requireAuth(
        {
          headers: request.headers as Record<string, unknown>,
          query: resolveRequestQuery(request),
        },
        telegramBotToken,
      );
      const params = request.params as { planId: string };
      const plan = getPlanById(params.planId);
      if (!plan) {
        reply.code(404);
        return { ok: false, error: 'Plan not found' };
      }

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'keep-alive',
        'cache-control': 'no-cache, no-transform',
      });

      sendSseEvent(res, 'connected', { ok: true, planId: params.planId });
      sendSseEvent(res, 'plan_updated', { plan });

      const existing =
        sseClients.get(params.planId) || new Set<ServerResponse>();
      existing.add(res);
      sseClients.set(params.planId, existing);

      const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
      }, 20_000);

      request.raw.on('close', () => {
        clearInterval(keepAlive);
        const clients = sseClients.get(params.planId);
        if (!clients) return;
        clients.delete(res);
        if (clients.size === 0) {
          sseClients.delete(params.planId);
        }
      });

      return undefined;
    } catch (err) {
      if (err instanceof Error && err.message === 'Unauthorized') {
        reply.code(401);
        return { ok: false, error: 'Unauthorized' };
      }
      throw err;
    }
  });

  app.post(
    '/api/plans/:planId/sections/:index/approve',
    async (request, reply) => {
      try {
        const auth = requireAuth(
          {
            headers: request.headers as Record<string, unknown>,
            query: resolveRequestQuery(request),
          },
          telegramBotToken,
        );
        const params = request.params as { planId: string; index: string };
        const sectionIndex = parseSectionIndexParam(params.index);
        if (sectionIndex === null) {
          reply.code(400);
          return { ok: false, error: 'Invalid section index' };
        }
        const plan = updatePlanSection({
          planId: params.planId,
          sectionIndex,
          status: 'approved',
          decidedBy: auth.userId,
        });
        writePlanEvent(
          plan.groupFolder,
          buildPlanEvent({
            type: 'section_approved',
            planId: params.planId,
            sectionIndex,
            userId: auth.userId,
          }),
        );
        return { ok: true, plan };
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          reply.code(401);
          return { ok: false, error: 'Unauthorized' };
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/plans/:planId/sections/:index/reject',
    async (request, reply) => {
      try {
        const auth = requireAuth(
          {
            headers: request.headers as Record<string, unknown>,
            query: resolveRequestQuery(request),
          },
          telegramBotToken,
        );
        const params = request.params as { planId: string; index: string };
        const sectionIndex = parseSectionIndexParam(params.index);
        if (sectionIndex === null) {
          reply.code(400);
          return { ok: false, error: 'Invalid section index' };
        }
        const body = resolveRequestBody(request);
        const reason =
          typeof body.reason === 'string' ? body.reason.trim() : '';
        const plan = updatePlanSection({
          planId: params.planId,
          sectionIndex,
          status: 'rejected',
          decidedBy: auth.userId,
          ...(reason ? { userFeedback: reason } : {}),
        });
        writePlanEvent(
          plan.groupFolder,
          buildPlanEvent({
            type: 'section_rejected',
            planId: params.planId,
            sectionIndex,
            userId: auth.userId,
            ...(reason ? { reason } : {}),
          }),
        );
        return { ok: true, plan };
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          reply.code(401);
          return { ok: false, error: 'Unauthorized' };
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/plans/:planId/sections/:index/edit',
    async (request, reply) => {
      try {
        const auth = requireAuth(
          {
            headers: request.headers as Record<string, unknown>,
            query: resolveRequestQuery(request),
          },
          telegramBotToken,
        );
        const params = request.params as { planId: string; index: string };
        const sectionIndex = parseSectionIndexParam(params.index);
        if (sectionIndex === null) {
          reply.code(400);
          return { ok: false, error: 'Invalid section index' };
        }
        const body = resolveRequestBody(request);
        const content = typeof body.content === 'string' ? body.content : '';
        if (!content.trim()) {
          reply.code(400);
          return { ok: false, error: 'content is required' };
        }

        const plan = updatePlanSection({
          planId: params.planId,
          sectionIndex,
          status: 'editing',
          userFeedback: content,
          decidedBy: auth.userId,
        });
        writePlanEvent(
          plan.groupFolder,
          buildPlanEvent({
            type: 'section_edited',
            planId: params.planId,
            sectionIndex,
            userId: auth.userId,
            newContent: content,
          }),
        );
        return { ok: true, plan };
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          reply.code(401);
          return { ok: false, error: 'Unauthorized' };
        }
        throw err;
      }
    },
  );

  app.post('/api/plans/:planId/approve-all', async (request, reply) => {
    try {
      const auth = requireAuth(
        {
          headers: request.headers as Record<string, unknown>,
          query: resolveRequestQuery(request),
        },
        telegramBotToken,
      );
      const params = request.params as { planId: string };
      const plan = approveAllPlanSections(params.planId, auth.userId);
      writePlanEvent(
        plan.groupFolder,
        buildPlanEvent({
          type: 'plan_approved',
          planId: params.planId,
          userId: auth.userId,
        }),
      );
      return { ok: true, plan };
    } catch (err) {
      if (err instanceof Error && err.message === 'Unauthorized') {
        reply.code(401);
        return { ok: false, error: 'Unauthorized' };
      }
      throw err;
    }
  });

  app.post('/api/plans/:planId/reject', async (request, reply) => {
    try {
      const auth = requireAuth(
        {
          headers: request.headers as Record<string, unknown>,
          query: resolveRequestQuery(request),
        },
        telegramBotToken,
      );
      const params = request.params as { planId: string };
      const body = resolveRequestBody(request);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      const plan = rejectPlan(params.planId, auth.userId);
      writePlanEvent(
        plan.groupFolder,
        buildPlanEvent({
          type: 'plan_rejected',
          planId: params.planId,
          userId: auth.userId,
          ...(reason ? { reason } : {}),
        }),
      );
      return { ok: true, plan };
    } catch (err) {
      if (err instanceof Error && err.message === 'Unauthorized') {
        reply.code(401);
        return { ok: false, error: 'Unauthorized' };
      }
      throw err;
    }
  });

  const unsubscribe = onPlanUpdated(({ plan }) => {
    const clients = sseClients.get(plan.id);
    if (!clients || clients.size === 0) return;
    for (const client of clients) {
      sendSseEvent(client, 'plan_updated', { plan });
    }
  });

  await app.listen({ host: MINI_APP_HOST, port: MINI_APP_PORT });
  logger.info(
    {
      host: MINI_APP_HOST,
      port: MINI_APP_PORT,
      corsOrigin: MINI_APP_CORS_ORIGIN || 'https://app.myclaw.dev',
      apiUrl: MINI_APP_API_URL || '(not set)',
    },
    'Mini App API server listening (Fastify, API only)',
  );

  return {
    close: async () => {
      unsubscribe();
      await app.close();
    },
  };
}
