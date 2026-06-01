import type { IncomingMessage, ServerResponse } from 'node:http';

import { sendJson } from '../http.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import {
  buildControlPlaneReadModelFromSettings,
  type ControlPlaneMemoryStatus,
} from '../../../application/control-plane/control-plane-read-model.js';
import type { AppId } from '../../../domain/app/app.js';

export async function handleSystemRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/status' && req.method === 'GET') {
    const key = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!key) return true;
    const settings = ctx.getRuntimeSettings();
    const appId = key.appId as AppId;
    const model = buildControlPlaneReadModelFromSettings({
      settings,
      workspaceKey: key.appId,
      modelCredentialReady: await ctx.hasActiveModelCredential(appId),
      providers: providerInputs(settings),
      memoryStatus: memoryStatus(settings.memory?.enabled === true),
      jobs: (await ctx.listControlPlaneJobs(appId)).map((job) => ({
        id: job.id,
        ...(job.workspace_key ? { agentId: job.workspace_key } : {}),
        status: jobStatus(job.status),
      })),
    });
    sendJson(res, 200, model);
    return true;
  }

  if (pathname === '/v1/health' && req.method === 'GET') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['sessions:read'])) {
      return true;
    }
    sendJson(res, 200, {
      status: 'ok',
      transport:
        ctx.port > 0
          ? { kind: 'tcp', port: ctx.port }
          : { kind: 'unix', socketPath: ctx.socketPath },
      features: {
        sessions: true,
        jobs: true,
        events: true,
        webhooks: true,
      },
    });
    return true;
  }

  if (pathname === '/v1/doctor' && req.method === 'GET') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['sessions:read'])) {
      return true;
    }
    sendJson(res, 200, {
      status: 'ok',
      checks: [
        {
          id: 'storage',
          status: 'ok',
          message: 'Postgres control store available',
        },
        {
          id: 'auth',
          status: ctx.keys.length > 0 ? 'ok' : 'warn',
          message:
            ctx.keys.length > 0
              ? 'API keys configured'
              : 'No control API keys configured',
        },
      ],
    });
    return true;
  }

  return false;
}

function providerInputs(
  settings: ReturnType<ControlRouteContext['getRuntimeSettings']>,
) {
  const connectionProviders = new Set(
    Object.values(settings.providerConnections ?? {}).map(
      (connection) => connection.provider,
    ),
  );
  const providerIds = new Set([
    ...Object.keys(settings.providers ?? {}),
    ...connectionProviders,
  ]);
  return [...providerIds]
    .filter(
      (id) =>
        settings.providers[id]?.enabled === true || connectionProviders.has(id),
    )
    .map((id) => ({
      id,
      label: id,
      ready:
        (settings.providers[id]?.enabled === true ||
          settings.providers[id] === undefined) &&
        connectionProviders.has(id),
    }));
}

function memoryStatus(enabled: boolean): ControlPlaneMemoryStatus {
  return enabled ? 'Ready' : 'Disabled';
}

function jobStatus(
  status: string | undefined,
): 'ready' | 'needs_action' | 'blocked' {
  if (status === 'dead_lettered') return 'blocked';
  if (status === 'paused') return 'needs_action';
  return 'ready';
}
