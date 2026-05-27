import type { IncomingMessage, ServerResponse } from 'node:http';

import { ModelCredentialService } from '../../../application/model-credentials/model-credential-service.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { AppId } from '../../../domain/app/app.js';
import {
  listSupportedModelCredentialProviders,
  normalizeModelCredentialProvider,
} from '../../../domain/model-credentials/model-credentials.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';

function modelCredentialService(): ModelCredentialService {
  const storage = getRuntimeStorage();
  return new ModelCredentialService(
    storage.repositories.modelCredentials,
    (event) => storage.runtimeEvents.publish(event),
  );
}

export async function handleCredentialRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (
    pathname !== '/v1/credentials/models' &&
    !pathname.startsWith('/v1/credentials/models/')
  ) {
    return false;
  }

  const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
  if (!auth) return true;
  const appId = auth.appId as AppId;

  if (pathname === '/v1/credentials/models') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    sendJson(res, 200, {
      providers: await modelCredentialService().list({ appId }),
    });
    return true;
  }

  const providerId = pathname.split('/').pop() || '';
  let normalizedProvider: ReturnType<typeof normalizeModelCredentialProvider>;
  try {
    normalizedProvider = normalizeModelCredentialProvider(providerId);
  } catch (error) {
    sendError(
      res,
      400,
      'INVALID_PROVIDER',
      error instanceof Error ? error.message : 'Invalid provider',
      { supported: listSupportedModelCredentialProviders() },
    );
    return true;
  }

  if (req.method === 'PUT') {
    const rawBody = await readJson(req);
    if (
      typeof rawBody !== 'object' ||
      rawBody === null ||
      Array.isArray(rawBody)
    ) {
      sendError(res, 400, 'INVALID_REQUEST', 'Request body must be JSON.');
      return true;
    }
    const payload = (rawBody as { payload?: unknown }).payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      sendError(res, 400, 'INVALID_REQUEST', 'payload is required.');
      return true;
    }
    const metadata = await modelCredentialService().set({
      appId,
      providerId: normalizedProvider,
      payload,
      actor: `control-api:${auth.kid}`,
    });
    sendJson(res, 200, {
      providerId: metadata.providerId,
      status: metadata.status,
      health: 'ready',
      fingerprint: metadata.fingerprint,
      fieldFingerprints: metadata.fieldFingerprints,
      schemaVersion: metadata.schemaVersion,
      updatedAt: metadata.updatedAt,
    });
    return true;
  }

  if (req.method === 'DELETE') {
    const metadata = await modelCredentialService().disable({
      appId,
      providerId: normalizedProvider,
      actor: `control-api:${auth.kid}`,
    });
    sendJson(res, 200, {
      providerId: normalizedProvider,
      status: metadata?.status ?? 'disabled',
      health: 'disabled',
      fingerprint: metadata?.fingerprint ?? null,
      fieldFingerprints: metadata?.fieldFingerprints ?? [],
      schemaVersion: metadata?.schemaVersion ?? null,
      updatedAt: metadata?.updatedAt ?? null,
    });
    return true;
  }

  res.setHeader('Allow', 'PUT, DELETE');
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  return true;
}
