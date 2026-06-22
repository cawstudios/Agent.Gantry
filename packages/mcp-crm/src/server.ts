import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Pool } from 'pg';
import type { BoondiCrmEnv } from './env.js';
import type { Logger } from './logger.js';
import { createPool } from './db/pool.js';
import {
  RecordsRepository,
  ResponseCommentTargetError,
} from './db/records-repository.js';
import {
  IDENTITY_HEADER_NAME,
  verifyIdentityHeader,
} from './identity/identity-header.js';
import { runWithIdentity } from './identity/identity-context.js';
import { registerAllTools } from './tools/index.js';
import { runManualConversationExtraction } from './watcher/index.js';
import { createAnthropicExtractorLlm } from './extractor/llm-client.js';

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function parseUrlPath(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    const path = parsed.pathname.replace(/\/+$/, '');
    return path === '' ? '/' : path;
  } catch {
    return null;
  }
}

function errToLog(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { err: { name: err.name, message: err.message, stack: err.stack } };
  }
  return { err: String(err) };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

type ResponseCommentRequest =
  | {
      action: 'upsert';
      messageId: string;
      conversationId: string;
      comment: string;
    }
  | {
      action: 'delete';
      messageId: string;
      conversationId: string;
    };

function parseResponseCommentRequest(body: unknown): ResponseCommentRequest {
  if (body == null || typeof body !== 'object') {
    throw new Error('Request body must be an object.');
  }
  const record = body as Record<string, unknown>;
  const action = record.action;
  const messageId =
    typeof record.messageId === 'string' ? record.messageId.trim() : '';
  const conversationId =
    typeof record.conversationId === 'string'
      ? record.conversationId.trim()
      : '';
  if (action !== 'upsert' && action !== 'delete') {
    throw new Error('action must be upsert or delete.');
  }
  if (!messageId) throw new Error('messageId is required.');
  if (!/^conversation:wa:\d+$/.test(conversationId)) {
    throw new Error('conversationId must be a WhatsApp conversation id.');
  }
  if (action === 'delete') {
    return { action, messageId, conversationId };
  }
  const comment =
    typeof record.comment === 'string' ? record.comment.trim() : '';
  if (!comment) throw new Error('comment is required.');
  if (comment.length > 4000) {
    throw new Error('comment must be 4000 characters or fewer.');
  }
  return { action, messageId, conversationId, comment };
}

function verifiedIdentityForRequest(
  req: IncomingMessage,
  env: BoondiCrmEnv,
  logger: Logger,
):
  | { ok: true; identity: ReturnType<typeof verifyIdentityHeader> }
  | { ok: false; status: number; payload: unknown } {
  const headerCheck = env.requireVerifiedIdentity
    ? verifyIdentityHeader(readHeader(req, IDENTITY_HEADER_NAME), {
        secret:
          env.identity.mode === 'disabled' ? undefined : env.identity.secret,
        maxAgeSec: env.identityMaxAgeSec,
      })
    : ({ kind: 'absent' } as const);

  if (headerCheck.kind === 'invalid') {
    const isAttackSignal =
      headerCheck.reason === 'BAD_SIGNATURE' ||
      headerCheck.reason === 'STALE_TIMESTAMP' ||
      headerCheck.reason === 'FUTURE_TIMESTAMP';
    (isAttackSignal ? logger.error : logger.warn)(
      { reason: headerCheck.reason },
      'boondi_crm_identity_header_invalid',
    );
    return {
      ok: false,
      status: 401,
      payload: { error: { code: 'IDENTITY_INVALID' } },
    };
  }

  return { ok: true, identity: headerCheck };
}

interface ReadBodyResult {
  ok: boolean;
  body?: unknown;
  rawLen: number;
  error?: string;
}

async function readRequestBody(req: IncomingMessage): Promise<ReadBodyResult> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const rawLen = chunks.reduce((acc, c) => acc + c.length, 0);
  if (rawLen === 0) return { ok: true, rawLen: 0, body: undefined };
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return { ok: true, rawLen, body: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      rawLen,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface StartHttpServerOptions {
  env: BoondiCrmEnv;
  logger: Logger;
  pool?: Pool; // injectable for tests
}

export interface RunningHttpServer {
  close: () => Promise<void>;
  pool: Pool;
  repo: RecordsRepository;
}

export async function startHttpServer(
  opts: StartHttpServerOptions,
): Promise<RunningHttpServer> {
  const { env, logger } = opts;
  const pool =
    opts.pool ??
    createPool(
      env.databaseUrl,
      env.dbSchema,
      env.crmLeadQueryExtractionWatcher.dbPoolSize,
    );
  const repo = new RecordsRepository(pool);

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const path = parseUrlPath(req.url);
      if (path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === '/admin/extract-leads-queries') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }
        const identity = verifiedIdentityForRequest(req, env, logger);
        if (!identity.ok) {
          sendJson(res, identity.status, identity.payload);
          return;
        }
        // The route triggers LLM spend + CRM writes: in required mode an
        // ABSENT identity header must not pass (verifiedIdentityForRequest
        // only rejects forged/stale ones). The production caller always
        // signs; /mcp keeps its own downstream tool-layer enforcement.
        if (env.requireVerifiedIdentity && identity.identity.kind !== 'ok') {
          logger.warn({}, 'boondi_crm_manual_extract_identity_missing');
          sendJson(res, 401, { error: { code: 'IDENTITY_REQUIRED' } });
          return;
        }
        const bodyResult = await readRequestBody(req);
        if (!bodyResult.ok || !bodyResult.body) {
          logger.warn(
            { rawLen: bodyResult.rawLen, err: bodyResult.error },
            'boondi_crm_body_parse_failed',
          );
          sendJson(res, 400, { error: 'malformed_json_body' });
          return;
        }
        const conversationId = (bodyResult.body as { conversationId?: unknown })
          .conversationId;
        if (
          typeof conversationId !== 'string' ||
          !/^conversation:wa:\d+$/.test(conversationId)
        ) {
          sendJson(res, 400, { error: 'invalid_conversation_id' });
          return;
        }
        // Silent zeros when the extractor is unconfigured confused operators
        // (looks identical to "nothing to extract") — surface it as a 503.
        const llm = createAnthropicExtractorLlm(env);
        if (!llm) {
          logger.warn({}, 'boondi_crm_manual_extract_disabled');
          sendJson(res, 503, { error: 'extractor_disabled' });
          return;
        }
        try {
          const stats = await runManualConversationExtraction(
            { env, logger, pool, repo, llm },
            conversationId,
          );
          sendJson(res, 200, { ok: true, stats });
        } catch (err) {
          logger.error(errToLog(err), 'boondi_crm_manual_extract_failed');
          sendJson(res, 500, { error: 'internal_error' });
        }
        return;
      }

      if (path === '/admin/response-comments') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }
        const identity = verifiedIdentityForRequest(req, env, logger);
        if (!identity.ok) {
          sendJson(res, identity.status, identity.payload);
          return;
        }
        if (identity.identity.kind !== 'ok') {
          logger.warn({}, 'boondi_crm_response_comment_identity_missing');
          sendJson(res, 401, { error: { code: 'IDENTITY_REQUIRED' } });
          return;
        }
        const authorEmail = identity.identity.identity.email;
        if (!authorEmail) {
          logger.warn({}, 'boondi_crm_response_comment_email_missing');
          sendJson(res, 401, {
            error: { code: 'IDENTITY_EMAIL_REQUIRED' },
          });
          return;
        }
        const bodyResult = await readRequestBody(req);
        if (!bodyResult.ok || !bodyResult.body) {
          logger.warn(
            { rawLen: bodyResult.rawLen, err: bodyResult.error },
            'boondi_crm_body_parse_failed',
          );
          sendJson(res, 400, { error: 'malformed_json_body' });
          return;
        }
        let body: ResponseCommentRequest;
        try {
          body = parseResponseCommentRequest(bodyResult.body);
        } catch {
          sendJson(res, 400, { error: 'invalid_request' });
          return;
        }
        try {
          if (body.action === 'delete') {
            await repo.deleteResponseComment({
              gantrySchema: env.gantrySchema,
              messageId: body.messageId,
              conversationId: body.conversationId,
            });
            sendJson(res, 200, { ok: true });
            return;
          }
          const comment = await repo.upsertResponseComment({
            gantrySchema: env.gantrySchema,
            messageId: body.messageId,
            conversationId: body.conversationId,
            commentText: body.comment,
            authorEmail,
          });
          sendJson(res, 200, { ok: true, comment });
        } catch (err) {
          if (err instanceof ResponseCommentTargetError) {
            sendJson(res, 404, {
              error: 'target_outbound_message_not_found',
            });
            return;
          }
          logger.error(errToLog(err), 'boondi_crm_response_comment_failed');
          sendJson(res, 500, { error: 'internal_error' });
        }
        return;
      }

      if (path !== '/mcp') {
        res.writeHead(404).end();
        return;
      }

      const identity = verifiedIdentityForRequest(req, env, logger);
      if (!identity.ok) {
        sendJson(res, identity.status, identity.payload);
        return;
      }
      const headerCheck = identity.identity;
      const verifiedIdentity =
        env.requireVerifiedIdentity && headerCheck.kind === 'ok'
          ? headerCheck.identity
          : null;

      const bodyResult = await readRequestBody(req);
      if (!bodyResult.ok) {
        logger.warn(
          { rawLen: bodyResult.rawLen, err: bodyResult.error },
          'boondi_crm_body_parse_failed',
        );
        sendJson(res, 400, { error: 'malformed_json_body' });
        return;
      }

      const server = new McpServer({ name: 'boondi-crm', version: '0.1.0' });
      registerAllTools(server, repo);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        transport
          .close()
          .catch((err) =>
            logger.warn(errToLog(err), 'boondi_crm_transport_close_failed'),
          );
        server
          .close()
          .catch((err) =>
            logger.warn(errToLog(err), 'boondi_crm_server_close_failed'),
          );
      });
      try {
        await runWithIdentity(verifiedIdentity, async () => {
          await server.connect(transport);
          await transport.handleRequest(req, res, bodyResult.body);
        });
      } catch (err) {
        logger.error(errToLog(err), 'boondi_crm_request_failed');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      }
    },
  );

  await new Promise<void>((resolve) =>
    httpServer.listen(env.port, '127.0.0.1', resolve),
  );

  logger.info(
    {
      port: env.port,
      schema: env.dbSchema,
      identityMode: env.identity.mode,
      bootedAt: new Date().toISOString(),
    },
    'boondi_crm_listening',
  );

  return {
    pool,
    repo,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (typeof httpServer.closeAllConnections === 'function') {
          httpServer.closeAllConnections();
        }
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
