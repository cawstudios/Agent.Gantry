import { loadDotenvUpwards } from './dotenv-load.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { startHttpServer } from './server.js';
import { startReconciler } from './reconciler/index.js';

// Public surface (also used by tests / the migrate + smoke scripts).
export { loadEnv } from './env.js';
export type { BoondiCrmEnv } from './env.js';
export { startHttpServer } from './server.js';
export { createPool } from './db/pool.js';
export { RecordsRepository } from './db/records-repository.js';
export type { BusinessRecord, RecordInput } from './db/types.js';
export { scoreLead, bandForScore } from './scoring.js';
export { registerAllTools, REGISTERED_TOOL_NAMES } from './tools/index.js';
export { createLogger } from './logger.js';
export {
  IDENTITY_HEADER_NAME,
  computeIdentitySignature,
  verifyIdentityHeader,
} from './identity/identity-header.js';

const isEntry =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/mcp-crm/dist/index.js') ||
    process.argv[1].endsWith('packages/mcp-crm/src/index.ts'));

if (isEntry) {
  loadDotenvUpwards();
  const env = loadEnv();
  const logger = createLogger({
    level: env.logLevel,
    format: env.logFormat,
    context: { service: 'mcp-crm' },
  });

  startHttpServer({ env, logger }).then(
    (running) => {
      // Durable backstop: reconstruct any missed/failed capture from the
      // durable transcript. Started here so it shares the same pool/lifecycle.
      const stopReconciler = startReconciler({
        env,
        logger,
        pool: running.pool,
        repo: running.repo,
      });

      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        stopReconciler();
        await running.close().catch(() => undefined);
        await running.pool.end().catch(() => undefined);
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    },
    (err) => {
      logger.fatal(
        { err: err instanceof Error ? err.message : String(err) },
        'boondi_crm_failed_to_start',
      );
      process.exit(1);
    },
  );
}
