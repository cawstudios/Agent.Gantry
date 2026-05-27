import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ModelCredentialService } from '../../../application/model-credentials/model-credential-service.js';
import type { AppId } from '../../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../../domain/events/runtime-event-types.js';
import type { AgentCredentialBroker } from '../../../domain/ports/agent-credential-broker.js';
import type { ModelCredentialRepository } from '../../../domain/ports/repositories.js';
import type {
  AgentCredentialBrokerInput,
  AgentCredentialBrokerCapabilities,
} from '../../../domain/ports/agent-credential-broker.js';
import type {
  AgentCredentialInjection,
  CredentialBrokerHealth,
} from '../../../domain/models/credentials.js';
import type { ModelCredentialProvider } from '../../../domain/model-credentials/model-credentials.js';
import {
  getModelProviderByGatewayPath,
  getModelProviderDefinition,
  getDefaultModelRouteProvider,
  listExecutableModelProviders,
  normalizeModelProviderId,
  type ModelCredentialPayload,
  type ModelProviderDefinition,
} from '../../../shared/model-provider-registry.js';
import { logger } from '../../../infrastructure/logging/logger.js';

const DEFAULT_APP_ID = 'default' as AppId;
const DEFAULT_LOOPBACK_HOST = '127.0.0.1';
const TOKEN_PREFIX = 'gtw_';
const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

interface GatewayTokenRecord {
  token: string;
  appId: AppId;
  providerId: ModelCredentialProvider;
  createdAtMs: number;
  expiresAtMs: number;
  agentId?: RuntimeEventPublishInput['agentId'];
  runId?: RuntimeEventPublishInput['runId'];
  jobId?: RuntimeEventPublishInput['jobId'];
  conversationId?: RuntimeEventPublishInput['conversationId'];
  threadId?: RuntimeEventPublishInput['threadId'];
}

export class GantryModelGatewayBroker implements AgentCredentialBroker {
  private readonly credentialService: ModelCredentialService;
  private server?: http.Server;
  private listenPromise?: Promise<void>;
  private port = 0;
  private readonly tokens = new Map<string, GatewayTokenRecord>();
  private readonly bindHost: string;
  private readonly tokenTtlMs: number;
  private readonly audit?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;

  constructor(
    private readonly credentials: ModelCredentialRepository,
    options: {
      bindHost?: string;
      tokenTtlMs?: number;
      audit?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
    } = {},
  ) {
    this.credentialService = new ModelCredentialService(credentials);
    this.bindHost = normalizeGatewayBindHost(
      options.bindHost ?? DEFAULT_LOOPBACK_HOST,
    );
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.audit = options.audit;
  }

  async getInjection(
    input: AgentCredentialBrokerInput,
  ): Promise<AgentCredentialInjection> {
    const provider = gatewayProviderFor(
      input.binding.modelCredentialProviderId ??
        input.binding.modelRouteId ??
        defaultGatewayProviderId(),
    );
    const providerId = provider.id as ModelCredentialProvider;
    const appId = input.binding.appId ?? DEFAULT_APP_ID;
    const credential = await this.credentialService.getActiveCredential({
      appId,
      providerId,
    });
    if (!credential) {
      throw new Error(
        `Model credential for ${providerId} is not configured. Run \`gantry credentials model set ${providerId}\`.`,
      );
    }
    await this.ensureListening();
    const token = `${TOKEN_PREFIX}${randomUUID().replace(/-/g, '')}`;
    this.tokens.set(token, {
      token,
      appId,
      providerId,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + this.tokenTtlMs,
      ...(input.binding.agentId ? { agentId: input.binding.agentId } : {}),
      ...(input.binding.runId ? { runId: input.binding.runId } : {}),
      ...(input.binding.jobId ? { jobId: input.binding.jobId } : {}),
      ...(input.binding.conversationId
        ? { conversationId: input.binding.conversationId }
        : {}),
      ...(input.binding.threadId ? { threadId: input.binding.threadId } : {}),
    });
    const env = projectGatewayTokenEnv({
      provider,
      baseUrl: `http://${hostForUrl(this.bindHost)}:${this.port}/${provider.gateway.pathSegment}`,
      token,
    });
    return {
      env,
      credentialProviders: {
        [provider.gateway.sdkProjection.credentialProviderEnvKey]:
          provider.gateway.sdkProjection.credentialProvider,
      },
      applied: true,
      brokerProfile: 'gantry',
    };
  }

  async healthCheck(
    input?: AgentCredentialBrokerInput,
  ): Promise<CredentialBrokerHealth> {
    const provider = gatewayProviderFor(
      input?.binding.modelCredentialProviderId ??
        input?.binding.modelRouteId ??
        defaultGatewayProviderId(),
    );
    const providerId = provider.id as ModelCredentialProvider;
    const appId = input?.binding.appId ?? DEFAULT_APP_ID;
    const credential = await this.credentials.getModelCredential({
      appId,
      providerId,
    });
    if (!credential || credential.status !== 'active') {
      return {
        status: 'fail',
        message: `Gantry Model Gateway is missing an active ${providerId} credential.`,
        nextAction: `Run \`gantry credentials model set ${providerId}\`.`,
      };
    }
    return {
      status: 'pass',
      message: `Gantry Model Gateway has an active ${provider.label} credential.`,
      details: [`fingerprint=${credential.fingerprint}`],
    };
  }

  getCapabilities(): AgentCredentialBrokerCapabilities {
    return {
      profile: 'gantry',
      supportsAgentBinding: false,
      supportsModelRuntimeProfile: true,
      modelRuntimeProfileIdentifier: 'gantry-model-access',
      returnsRawSecrets: false,
      projectsProviderTokens: false,
      projectedSecretEnvKeys: projectedGatewayEnvKeys(),
    };
  }

  async revokeInjection(input: AgentCredentialBrokerInput): Promise<void> {
    const provider = gatewayProviderFor(
      input.binding.modelCredentialProviderId ??
        input.binding.modelRouteId ??
        defaultGatewayProviderId(),
    );
    const providerId = provider.id as ModelCredentialProvider;
    const appId = input.binding.appId ?? DEFAULT_APP_ID;
    for (const [token, record] of this.tokens.entries()) {
      if (
        record.appId === appId &&
        record.providerId === providerId &&
        (!input.binding.runId || record.runId === input.binding.runId)
      ) {
        this.tokens.delete(token);
      }
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listenPromise = undefined;
    this.port = 0;
    this.tokens.clear();
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private ensureListening(): Promise<void> {
    if (this.port > 0) return Promise.resolve();
    this.listenPromise ??= new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res).catch((error) => {
          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader('content-type', 'application/json');
          }
          res.end(
            JSON.stringify({
              error: 'Gantry Model Gateway request failed',
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        });
      });
      server.on('error', reject);
      server.listen(0, this.bindHost, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Gantry Model Gateway did not bind a TCP port.'));
          return;
        }
        this.server = server;
        this.port = address.port;
        resolve();
      });
    });
    return this.listenPromise;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const parsedUrl = new URL(
      req.url || '/',
      `http://${hostForUrl(this.bindHost)}`,
    );
    const [providerSegment, ...pathParts] = parsedUrl.pathname
      .split('/')
      .filter(Boolean);
    const provider = gatewayProviderForPath(providerSegment || '');
    const providerId = provider.id as ModelCredentialProvider;
    const token = readBearerToken(req);
    const tokenRecord = token ? this.tokens.get(token) : undefined;
    if (
      !tokenRecord ||
      tokenRecord.providerId !== providerId ||
      !constantTimeEquals(tokenRecord.token, token)
    ) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Unauthorized model gateway request' }));
      return;
    }
    if (Date.now() >= tokenRecord.expiresAtMs) {
      this.tokens.delete(tokenRecord.token);
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Expired model gateway token' }));
      return;
    }

    const credential = await this.credentialService.getActiveCredential({
      appId: tokenRecord.appId,
      providerId,
    });
    if (!credential) {
      await this.publishGatewayUseAudit(tokenRecord, {
        outcome: 'credential_missing',
        method: req.method ?? 'GET',
        status: 503,
      });
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: `No active ${providerId} model credential is configured`,
        }),
      );
      return;
    }

    const upstreamPath = `/${pathParts.join('/')}`;
    const upstreamUrl = new URL(
      `${provider.gateway.upstreamPathPrefix}${upstreamPath}${parsedUrl.search}`,
      provider.gateway.upstreamOrigin,
    );
    const body = await readRequestBody(req);
    const headers = sanitizeProxyHeaders(req.headers, provider);
    injectProviderAuth(headers, provider, credential.payload);

    const response = await fetch(upstreamUrl, {
      method: req.method ?? 'GET',
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    await this.publishGatewayUseAudit(tokenRecord, {
      outcome: response.ok ? 'forwarded' : 'upstream_error',
      method: req.method ?? 'GET',
      status: response.status,
      upstreamHost: upstreamUrl.host,
      upstreamPath: upstreamUrl.pathname,
      credentialFingerprint: credential.fingerprint,
    });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(key, value);
    });
    await pipeUpstreamBody(response, res);
  }

  private async publishGatewayUseAudit(
    tokenRecord: GatewayTokenRecord,
    input: {
      outcome: 'forwarded' | 'upstream_error' | 'credential_missing';
      method: string;
      status: number;
      upstreamHost?: string;
      upstreamPath?: string;
      credentialFingerprint?: string;
    },
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit({
        appId: tokenRecord.appId,
        ...(tokenRecord.agentId ? { agentId: tokenRecord.agentId } : {}),
        ...(tokenRecord.runId ? { runId: tokenRecord.runId } : {}),
        ...(tokenRecord.jobId ? { jobId: tokenRecord.jobId } : {}),
        ...(tokenRecord.conversationId
          ? { conversationId: tokenRecord.conversationId }
          : {}),
        ...(tokenRecord.threadId ? { threadId: tokenRecord.threadId } : {}),
        eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_USED,
        actor: 'gantry-model-gateway',
        payload: {
          providerId: tokenRecord.providerId,
          outcome: input.outcome,
          method: input.method,
          status: input.status,
          tokenIssuedAtMs: tokenRecord.createdAtMs,
          tokenExpiresAtMs: tokenRecord.expiresAtMs,
          ...(input.credentialFingerprint
            ? { credentialFingerprint: input.credentialFingerprint }
            : {}),
          ...(input.upstreamHost ? { upstreamHost: input.upstreamHost } : {}),
          ...(input.upstreamPath ? { upstreamPath: input.upstreamPath } : {}),
        },
      });
    } catch (err) {
      logger.warn({ err }, 'Gantry Model Gateway usage audit failed');
    }
  }
}

function normalizeGatewayBindHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1'
  ) {
    return normalized;
  }
  throw new Error(
    'Gantry Model Gateway bind host must be a loopback host: 127.0.0.1, ::1, or localhost.',
  );
}

function hostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function gatewayProviderFor(providerId: string): ModelProviderDefinition {
  const normalized = normalizeModelProviderId(providerId);
  const provider = getModelProviderDefinition(normalized);
  if (provider?.executable && provider.gateway) return provider;
  throw new Error(`Unsupported model gateway provider: ${providerId}`);
}

function defaultGatewayProviderId(): string {
  const provider = getDefaultModelRouteProvider();
  if (!provider) {
    throw new Error('No default model gateway provider is registered.');
  }
  return provider.id;
}

function gatewayProviderForPath(pathSegment: string): ModelProviderDefinition {
  const provider = getModelProviderByGatewayPath(pathSegment);
  if (provider?.executable && provider.gateway) return provider;
  throw new Error(`Unsupported model gateway provider: ${pathSegment}`);
}

function projectGatewayTokenEnv(input: {
  provider: ModelProviderDefinition;
  baseUrl: string;
  token: string;
}): Record<string, string> {
  const projection = input.provider.gateway.sdkProjection;
  return {
    [projection.baseUrlEnv]: input.baseUrl,
    [projection.tokenEnv]: input.token,
    ...(projection.additionalTokenEnv
      ? { [projection.additionalTokenEnv]: input.token }
      : {}),
  };
}

function projectedGatewayEnvKeys(): string[] {
  return [
    ...new Set(
      listExecutableModelProviders().flatMap((provider) => {
        const projection = provider.gateway.sdkProjection;
        return [
          projection.baseUrlEnv,
          projection.tokenEnv,
          projection.additionalTokenEnv,
        ].filter((key): key is string => Boolean(key));
      }),
    ),
  ].sort();
}

function injectProviderAuth(
  headers: Record<string, string>,
  provider: ModelProviderDefinition,
  payload: ModelCredentialPayload,
): void {
  const auth = provider.gateway.auth;
  const value = payload[auth.field];
  if (!value) {
    throw new Error(
      `Model credential payload for ${provider.id} is missing ${auth.field}.`,
    );
  }
  if (auth.type === 'bearer') {
    headers.authorization = `Bearer ${value}`;
    return;
  }
  headers[auth.headerName ?? auth.field] = value;
}

async function pipeUpstreamBody(
  response: Response,
  res: http.ServerResponse,
): Promise<void> {
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    res,
  );
}

function readBearerToken(req: http.IncomingMessage): string {
  const authorization = req.headers.authorization;
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim();
  }
  const apiKey = req.headers['x-api-key'];
  if (Array.isArray(apiKey)) return apiKey[0] || '';
  return apiKey || '';
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sanitizeProxyHeaders(
  headers: http.IncomingHttpHeaders,
  provider: ModelProviderDefinition,
): Record<string, string> {
  const out: Record<string, string> = {};
  const stripped = new Set(
    provider.gateway.stripRequestHeaders.map((header) => header.toLowerCase()),
  );
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (stripped.has(lower)) {
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.join(', ');
    } else if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}
