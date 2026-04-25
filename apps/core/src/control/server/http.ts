import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const maxBytes = 64 * 1024;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      const error = Object.assign(new Error('Payload too large'), {
        code: 'PAYLOAD_TOO_LARGE',
        statusCode: 413,
      });
      reject(error);
      req.destroy();
      return;
    }
    req.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        const error = Object.assign(new Error('Payload too large'), {
          code: 'PAYLOAD_TOO_LARGE',
          statusCode: 413,
        });
        reject(error);
        req.destroy(error);
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(
          Object.assign(new Error('Invalid JSON body'), {
            code: 'INVALID_JSON',
            statusCode: 400,
          }),
        );
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(`${JSON.stringify(body)}\n`);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  sendJson(res, status, {
    error: {
      code,
      message,
      details: details ?? null,
      retryable: status >= 500,
      requestId: randomUUID(),
    },
  });
}
