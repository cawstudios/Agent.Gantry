import { loadDotenvUpwards } from './dotenv-load.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { startHttpServer } from './server.js';

export { TokenManager } from './auth/token-manager.js';
export { ShopifyClient } from './shopify/client.js';
export { ShopifyAdapterError, isShopifyAdapterError } from './errors.js';
export { verifyIdentity, normalizePhone, normalizeEmail } from './privacy/guard.js';
export { withExponentialBackoff } from './retry.js';
export { buildMcpServer, startHttpServer } from './server.js';
export { loadEnv } from './env.js';
export { loadDotenvUpwards } from './dotenv-load.js';
export {
  IDENTITY_HEADER_NAME,
  computeIdentitySignature,
  canonicalIdentityString,
  verifyIdentityHeader,
  type VerifiedIdentity,
  type VerifyHeaderResult,
} from './identity/identity-header.js';
export {
  runWithIdentity,
  getVerifiedIdentity,
} from './identity/identity-context.js';
export { createLogger } from './logger.js';
export {
  REGISTERED_TOOL_NAMES,
  registerAllTools,
  assertReadOnlyToolNames,
} from './tools/index.js';

const isEntry =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/mcp-shopify/dist/index.js') ||
    process.argv[1].endsWith('packages/mcp-shopify/src/index.ts'));

if (isEntry) {
  loadDotenvUpwards();
  const env = loadEnv();
  const logger = createLogger({
    level: env.logLevel as 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    format: env.logFormat,
    context: { service: 'mcp-shopify' },
  });

  startHttpServer({ env, logger }).then(
    (running) => {
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        running.tokenManager.stop();
        await running.close().catch(() => undefined);
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    },
    (err) => {
      logger.fatal(
        { err: err instanceof Error ? err.message : String(err) },
        'shopify_mcp_failed_to_start',
      );
      process.exit(1);
    },
  );
}
