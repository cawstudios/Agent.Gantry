import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';

export async function createControlHttpAdapterServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });

  await server.register(helmet);
  await server.register(cors, { origin: false });

  server.get('/health', async () => ({ ok: true }));

  return server;
}
